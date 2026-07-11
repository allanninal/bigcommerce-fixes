"""Detect and repair BigCommerce orders whose shipping address changed but
whose tax and shipping totals never recomputed.

BigCommerce's V2 Orders API treats the order shipping address as a plain
address record, not a pricing input. PUT /v2/orders/{id}/shippingaddresses/{id}
only writes street/city/zip/country fields and never re-runs the shipping-rate
lookup or the tax engine, because both only happen inside cart and checkout
consignment flows on /v3/checkouts, not on the order object itself. Order-level
fields like base_shipping_cost, shipping_cost_ex_tax/inc_tax, and total_tax are
static snapshots taken at order creation, so editing the address afterward
silently desyncs those money fields from the real destination.

This job lists candidate orders, diffs the live shipping address against a
saved address hash, and for orders that are still in an editable status
(Incomplete, Pending, Awaiting Payment, Awaiting Shipment, Awaiting
Fulfillment) with stale totals, builds a fresh checkout consignment quote and
a fresh tax estimate, then writes shipping_cost_ex_tax, shipping_cost_inc_tax,
and total_tax back together. Orders in a locked status (Shipped, Partially
Shipped, Refunded, Cancelled, Declined, Completed, Disputed, Partially
Refunded) are always skipped. Safe to run again and again. Defaults to
DRY_RUN, which only logs what it would flag or write.

Guide: https://www.allanninal.dev/bigcommerce/shipping-address-update-stale-totals/
"""
import hashlib
import logging
import os

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recompute_stale_totals")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
V2_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
V3_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EDITABLE_STATUSES = {0, 1, 7, 9, 11}
LOCKED_STATUSES = {2, 3, 4, 5, 6, 10, 13, 14}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(base, path, params=None):
    r = requests.get(f"{base}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(base, path, body):
    r = requests.put(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_post(base, path, body):
    r = requests.post(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def hash_address(address: dict) -> str:
    """Stable hash of the fields that actually affect shipping and tax."""
    parts = [
        (address or {}).get("street_1", ""),
        (address or {}).get("city", ""),
        (address or {}).get("state", ""),
        (address or {}).get("zip", ""),
        (address or {}).get("country_iso2", ""),
    ]
    raw = "|".join(p.strip().lower() for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def decide_recompute(order: dict, live_shipping_address: dict, cached_address_hash: str) -> dict:
    """Pure decision logic (no I/O). Given the last-known order dict (with
    total_tax, shipping_cost_ex_tax, shipping_cost_inc_tax, base_shipping_cost,
    status_id, date_modified) and the current live shipping address plus the
    previously recorded address hash, decide whether the order's totals are
    stale and whether a repair write is safe to apply.

    Returns: {
      "address_changed": bool,
      "stale_totals": bool,
      "action": "flag_only" | "recompute" | "skip_locked_status",
      "reason": str,
    }

    Logic:
      1. new_hash = hash(live_shipping_address street_1/city/state/zip/country_iso2)
      2. address_changed = (new_hash != cached_address_hash)
      3. locked_statuses = {2,3,4,5,6,10,13,14}  # Shipped/Refunded/Cancelled/etc.
      4. if order["status_id"] in locked_statuses: action = "skip_locked_status"
      5. elif address_changed and totals unchanged since cached snapshot:
           stale_totals = True; action = "recompute"
      6. else: stale_totals = False; action = "flag_only" (no-op)

    This function never reads DRY_RUN. It decides what *should* happen to an
    order; the caller (run(), below) is the only place that decides whether a
    "recompute" action is actually written or only logged, based on DRY_RUN.

    order["_totals_unchanged_since_snapshot"] defaults to True: callers that
    already know the totals moved (for example because date_modified moved
    after the address changed) should pass False explicitly.
    """
    new_hash = hash_address(live_shipping_address)
    address_changed = new_hash != cached_address_hash
    status_id = order.get("status_id")

    if status_id in LOCKED_STATUSES:
        return {
            "address_changed": address_changed,
            "stale_totals": False,
            "action": "skip_locked_status",
            "reason": f"status_id {status_id} is locked; totals are never rewritten.",
        }

    totals_unchanged = order.get("_totals_unchanged_since_snapshot", True)

    if address_changed and totals_unchanged:
        return {
            "address_changed": True,
            "stale_totals": True,
            "action": "recompute",
            "reason": "Address changed but total_tax/shipping_cost did not move.",
        }

    return {
        "address_changed": address_changed,
        "stale_totals": False,
        "action": "flag_only",
        "reason": "No stale totals detected.",
    }


def candidate_orders():
    """Page through orders in an editable status within the lookback window."""
    page = 1
    while True:
        orders = bc_get(
            V2_BASE,
            "/orders",
            {
                "min_date_modified": f"-{LOOKBACK_DAYS} days",
                "status_id": ",".join(str(s) for s in sorted(EDITABLE_STATUSES | LOCKED_STATUSES)),
                "page": page,
                "limit": 50,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def live_shipping_address(order_id):
    addresses = bc_get(V2_BASE, f"/orders/{order_id}/shippingaddresses")
    return addresses[0] if addresses else None


def order_line_items(order_id):
    return bc_get(V2_BASE, f"/orders/{order_id}/products")


def get_shipping_quote(checkout_id, new_address, line_items):
    body = {"line_items": line_items, "shipping_address": new_address}
    result = bc_post(
        V3_BASE,
        f"/checkouts/{checkout_id}/consignments?include=consignments.availableShippingOptions",
        [body],
    )
    consignments = (result or {}).get("data", {}).get("consignments", [])
    options = consignments[0].get("available_shipping_options", []) if consignments else []
    return options[0] if options else None


def get_tax_estimate(new_address, line_items):
    body = {"address": new_address, "line_items": line_items}
    return bc_post(V3_BASE, "/tax-provider/estimate", body)


def write_recomputed_totals(order_id, shipping_ex_tax, shipping_inc_tax, total_tax, subtotal_tax, handling_cost):
    body = {
        "shipping_cost_ex_tax": f"{shipping_ex_tax:.2f}",
        "shipping_cost_inc_tax": f"{shipping_inc_tax:.2f}",
        "total_tax": f"{total_tax:.2f}",
        "subtotal_tax": f"{subtotal_tax:.2f}",
        "handling_cost": f"{handling_cost:.2f}",
    }
    return bc_put(V2_BASE, f"/orders/{order_id}", body)


def load_cached_address_hash(order_id):
    """Placeholder for your own persistence layer (database, key/value store).
    Replace with a real lookup keyed on order_id. Returning None means
    "never seen before," which is treated as a change on the first pass.
    """
    return None


def save_address_hash(order_id, address_hash):
    """Placeholder for your own persistence layer."""
    return None


def run():
    recomputed = 0
    flagged = 0
    skipped = 0

    for order in candidate_orders():
        order_id = order["id"]
        status_id = order.get("status_id")
        address = live_shipping_address(order_id)
        cached_hash = load_cached_address_hash(order_id)

        decision = decide_recompute(order, address, cached_hash)

        if decision["action"] == "skip_locked_status":
            skipped += 1
            continue

        if decision["action"] == "flag_only":
            if decision["stale_totals"]:
                log.warning(
                    "Order %s flagged for review. status_id=%s reason=%s",
                    order_id, status_id, decision["reason"],
                )
                flagged += 1
            save_address_hash(order_id, hash_address(address))
            continue

        line_items = order_line_items(order_id)
        checkout_id = order.get("checkout_id") or order.get("cart_id")
        shipping_option = get_shipping_quote(checkout_id, address, line_items) if checkout_id else None
        tax_estimate = get_tax_estimate(address, line_items)

        shipping_ex_tax = float((shipping_option or {}).get("cost", 0) or 0)
        tax_total = float((tax_estimate or {}).get("total_tax", 0) or 0)
        shipping_inc_tax = shipping_ex_tax + tax_total
        subtotal_tax = float((tax_estimate or {}).get("subtotal_tax", tax_total) or tax_total)
        handling_cost = float(order.get("handling_cost_ex_tax", 0) or 0)

        log.info(
            "order_id=%s status_id=%s new_shipping_ex_tax=%.2f new_shipping_inc_tax=%.2f "
            "new_total_tax=%.2f (%s)",
            order_id, status_id, shipping_ex_tax, shipping_inc_tax, tax_total,
            "dry run" if DRY_RUN else "writing",
        )

        if not DRY_RUN:
            write_recomputed_totals(
                order_id, shipping_ex_tax, shipping_inc_tax, tax_total, subtotal_tax, handling_cost
            )
        save_address_hash(order_id, hash_address(address))
        recomputed += 1

    log.info(
        "Done. %d order(s) %s, %d flagged for review, %d skipped (locked status).",
        recomputed, "to recompute" if DRY_RUN else "recomputed", flagged, skipped,
    )


if __name__ == "__main__":
    run()
