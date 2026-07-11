"""Find and safely clean up orphaned duplicate carts from the B2B Buyer Portal.

BigCommerce carts are anonymous by default. A cart is created against a
storefront checkout/session cart_id and only gets a customer_id attached when
the shopper is logged in at the moment items are added, via a PUT to
/v3/carts/{cartId} or storefront session binding. The B2B Buyer Portal has no
reliable way to rehydrate a customer's prior cart on a new device or after a
fresh login, because the Carts API has no "list carts by customer_id"
endpoint, and the portal's SPA state and the storefront cart cookie are both
scoped to the browser. Login, logout, and device switches therefore spawn a
new anonymous cart_id, and the old cart is simply abandoned until BigCommerce
auto-expires it after 30 days without modification.

This job rebuilds a {cart_id, customer_id, created_at, updated_at} mapping
from your own tracked source (checkout redirects, order or webhook logs),
re-reads each cart's live state from the Carts API, groups by customer_id, and
classifies duplicates with a pure function: the most recently updated cart is
canonical, an older cart whose items are a subset of the canonical cart is
safely deletable, and an older cart with items the canonical cart lacks is
flagged for a manual merge, never auto-merged or deleted. Deletion only
happens when DRY_RUN is explicitly turned off, because a deleted cart cannot
be recovered.

Guide: https://www.allanninal.dev/bigcommerce/b2b-cart-not-persisted-across-sessions/
"""
import os
import logging
import time

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_b2b_carts")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
CART_VALIDITY_DAYS = int(os.environ.get("CART_VALIDITY_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_delete(path):
    r = requests.delete(f"{API_BASE}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return True


def classify_cart_duplicates(carts, now_epoch, validity_days=30):
    """Pure decision. No network, no side effects.

    carts: list of {"cart_id": str, "customer_id": int, "updated_time": int
    (epoch seconds), "line_item_skus": frozenset[str]}.

    Returns: {customer_id_str: {"canonical": cart_id,
    "orphans_deletable": [cart_id...], "orphans_needs_merge": [cart_id...]}}

    Decision logic (no I/O, pure):
      1. Drop expired carts where (now_epoch - updated_time) > validity_days * 86400.
      2. Group remaining carts by customer_id (skip customer_id == 0 / None,
         anonymous carts are not duplicates by definition).
      3. Within each group with len > 1, canonical = cart with max(updated_time).
      4. For every non-canonical cart in the group:
         - if its line_item_skus is a subset of canonical's line_item_skus -> orphans_deletable
         - else -> orphans_needs_merge
    """
    live = [c for c in carts if (now_epoch - c["updated_time"]) <= validity_days * 86400]

    by_customer = {}
    for cart in live:
        cid = cart.get("customer_id")
        if not cid:
            continue
        by_customer.setdefault(str(cid), []).append(cart)

    result = {}
    for customer_id, group in by_customer.items():
        if len(group) <= 1:
            continue
        canonical = max(group, key=lambda c: c["updated_time"])
        deletable = []
        needs_merge = []
        for cart in group:
            if cart["cart_id"] == canonical["cart_id"]:
                continue
            if cart["line_item_skus"] <= canonical["line_item_skus"]:
                deletable.append(cart["cart_id"])
            else:
                needs_merge.append(cart["cart_id"])
        result[customer_id] = {
            "canonical": canonical["cart_id"],
            "orphans_deletable": deletable,
            "orphans_needs_merge": needs_merge,
        }
    return result


def fetch_cart(cart_id):
    """Returns None if the cart is already gone (expired or deleted)."""
    try:
        resp = bc_get(f"/carts/{cart_id}")
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return None
        raise
    return resp.get("data")


def line_item_skus(cart_data):
    line_items = cart_data.get("line_items") or {}
    physical = line_items.get("physical_items") or []
    digital = line_items.get("digital_items") or []
    return frozenset(item.get("sku") for item in [*physical, *digital] if item.get("sku"))


def active_customer_ids(customer_ids):
    if not customer_ids:
        return set()
    ids_param = ",".join(str(cid) for cid in customer_ids)
    resp = bc_get("/customers", {"id:in": ids_param})
    return {row["id"] for row in resp.get("data", [])}


def load_tracked_cart_ids():
    """Replace this with your own store of tracked cart_ids.

    BigCommerce has no endpoint to list carts, so this must come from your own
    checkout redirect events, order logs, or webhook history captured at cart
    creation time.
    """
    raise NotImplementedError("Wire this up to your own cart_id tracking store")


def run():
    now_epoch = int(time.time())
    tracked_ids = load_tracked_cart_ids()

    carts = []
    for cart_id in tracked_ids:
        data = fetch_cart(cart_id)
        if data is None:
            continue
        carts.append({
            "cart_id": data["id"],
            "customer_id": data.get("customer_id"),
            "updated_time": data.get("updated_time", now_epoch),
            "line_item_skus": line_item_skus(data),
        })

    duplicates = classify_cart_duplicates(carts, now_epoch, CART_VALIDITY_DAYS)

    active_ids = active_customer_ids([int(cid) for cid in duplicates.keys()])

    deleted = 0
    flagged = 0
    for customer_id, info in duplicates.items():
        if int(customer_id) not in active_ids:
            log.warning("customer_id=%s no longer active, skipping cleanup entirely", customer_id)
            continue

        for orphan_id in info["orphans_needs_merge"]:
            log.warning(
                "customer_id=%s orphan cart_id=%s needs manual merge into canonical cart_id=%s",
                customer_id, orphan_id, info["canonical"],
            )
            flagged += 1

        for orphan_id in info["orphans_deletable"]:
            log.info(
                "customer_id=%s orphan cart_id=%s is a subset of canonical cart_id=%s (%s)",
                customer_id, orphan_id, info["canonical"],
                "dry run" if DRY_RUN else "deleting",
            )
            if not DRY_RUN:
                bc_delete(f"/carts/{orphan_id}")
            deleted += 1

    log.info(
        "Done. %d orphan cart(s) %s, %d orphan(s) flagged for manual merge.",
        deleted, "to delete" if DRY_RUN else "deleted", flagged,
    )


if __name__ == "__main__":
    run()
