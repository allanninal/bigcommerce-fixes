"""Find and safely clean up BigCommerce cart records that have piled up.

A BigCommerce V3 cart, created via the Storefront or Management Cart API, never
expires and never self-deletes on the server. It persists indefinitely until it
either converts to an order or is explicitly deleted through the API. Guest
checkouts, abandoned-cart-recovery emails, headless storefront sessions, and app
integrations all create carts liberally, and the "abandoned" definition (one hour
of inactivity) only triggers a recovery email, never any cleanup. Stores end up
with a growing pile of stale, empty, or orphaned cart records with no built-in
garbage collection.

This pages GET /v3/carts, reads each cart's age and line item counts, cross-checks
GET /v2/orders to see if the cart actually converted through a different path,
and classifies each cart with a pure function into empty_cart, converted_duplicate,
abandoned_stale, or active. Only empty_cart and converted_duplicate are ever hard
deleted with DELETE /v3/carts/{cartId}. abandoned_stale carts, which still have
real items and no confirmed order, are only ever flagged for review, never
auto-deleted. Guarded by DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/abandoned-cart-records-pile-up/
"""
import os
import logging
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clean_stale_carts")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
STALE_DAYS = int(os.environ.get("STALE_DAYS", "30"))

SAFE_DELETE_REASONS = frozenset({"empty_cart", "converted_duplicate"})


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    if not r.content:
        return None
    return r.json()


def classify_stale_cart(cart, matching_order_exists, now_iso, stale_days=30):
    """cart: {"id","customerId","email","createdTime","updatedTime","lineItemCounts"}
    Pure, no I/O. Decision logic only, no network calls.
    Returns {"isStale": bool, "reason": str}.

    - empty_cart: no line items at all, past the stale threshold. Safe to hard delete.
    - converted_duplicate: a matching order exists regardless of age. Safe to hard
      delete, it is an orphaned leftover from a checkout that completed elsewhere.
    - abandoned_stale: real items, past the stale threshold, no matching order.
      Flag only, never auto-delete, since it may be a cart a shopper still expects.
    - active: everything else.
    """
    updated = datetime.fromisoformat(cart["updatedTime"].replace("Z", "+00:00"))
    now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    age_days = (now - updated).total_seconds() / 86400

    counts = cart["lineItemCounts"]
    total_items = counts["physical"] + counts["digital"] + counts["custom"] + counts["giftCert"]

    if total_items == 0 and age_days > stale_days:
        return {"isStale": True, "reason": "empty_cart"}
    if matching_order_exists:
        return {"isStale": True, "reason": "converted_duplicate"}
    if total_items > 0 and age_days > stale_days and not matching_order_exists:
        return {"isStale": True, "reason": "abandoned_stale"}
    return {"isStale": False, "reason": "active"}


def all_carts():
    """Yield every cart, paginated using meta.pagination."""
    page = 1
    limit = 250
    while True:
        body = bc("GET", f"/v3/carts?limit={limit}&page={page}") or {}
        batch = body.get("data") or []
        if not batch:
            return
        for cart in batch:
            yield cart
        pagination = (body.get("meta") or {}).get("pagination") or {}
        if page >= pagination.get("total_pages", page):
            return
        page += 1


def has_matching_order(customer_id, min_date_created):
    """True if the customer already has an order placed at or after min_date_created."""
    if not customer_id:
        return False
    qs = f"customer_id={customer_id}&min_date_created={min_date_created}&limit=1"
    orders = bc("GET", f"/v2/orders?{qs}") or []
    return len(orders) > 0


def line_item_counts(cart):
    items = cart.get("line_items") or {}
    return {
        "physical": len(items.get("physical_items") or []),
        "digital": len(items.get("digital_items") or []),
        "custom": len(items.get("custom_items") or []),
        "giftCert": len(items.get("gift_certificates") or []),
    }


def normalize_cart(cart):
    return {
        "id": cart["id"],
        "customerId": cart.get("customer_id"),
        "email": cart.get("email"),
        "createdTime": cart.get("created_time"),
        "updatedTime": cart.get("updated_time"),
        "lineItemCounts": line_item_counts(cart),
    }


def delete_cart(cart_id):
    """Hard delete. Only ever called for a safe-delete reason."""
    bc("DELETE", f"/v3/carts/{cart_id}")


def flag_cart_for_review(cart_id, updated_time):
    """Tag a real abandoned cart for review. Never deletes it."""
    bc("POST", f"/v3/carts/{cart_id}/metafields", json={
        "key": "stale", "value": "true", "namespace": "cart_cleanup", "permission_set": "write",
    })
    bc("POST", f"/v3/carts/{cart_id}/metafields", json={
        "key": "staleSince", "value": updated_time, "namespace": "cart_cleanup", "permission_set": "write",
    })


def run():
    now_iso = datetime.now(timezone.utc).isoformat()
    deleted = 0
    flagged = 0

    for raw_cart in all_carts():
        cart = normalize_cart(raw_cart)
        matching_order_exists = has_matching_order(cart["customerId"], cart["createdTime"])
        result = classify_stale_cart(cart, matching_order_exists, now_iso, STALE_DAYS)

        if not result["isStale"]:
            continue

        if result["reason"] in SAFE_DELETE_REASONS:
            log.info("Cart %s reason=%s. %s", cart["id"], result["reason"],
                      "would delete" if DRY_RUN else "deleting")
            if not DRY_RUN:
                delete_cart(cart["id"])
            deleted += 1
        else:
            log.info("Cart %s reason=%s staleSince=%s. %s", cart["id"], result["reason"], cart["updatedTime"],
                      "would flag" if DRY_RUN else "flagging")
            if not DRY_RUN:
                flag_cart_for_review(cart["id"], cart["updatedTime"])
            flagged += 1

    log.info("Done. %d cart(s) %s, %d cart(s) %s.",
              deleted, "to delete" if DRY_RUN else "deleted",
              flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
