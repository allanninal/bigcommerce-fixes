"""Detect BigCommerce multi-address checkout consignment drift.

Multi-address checkout represents each shipping destination as its own
consignment object holding its own line_items (item_id and quantity), and the
storefront or headless client is responsible for calling assignItemsToAddress
or unassignItemsToAddress (or POST/PUT /checkouts/{id}/consignments) once per
address as the shopper works through the flow. Because these are sequential,
independent calls against a mutable checkout resource with optimistic
concurrency version checks, a slow network, a retried request, or a client
that does not re-fetch checkout state between calls can leave an item
duplicated across consignments or unassigned to any of them by the time the
checkout converts to an order. Once converted, each order line item is
stamped with a single order_address_id, so the drift becomes a permanent,
silent mismatch between what the customer intended per address and what the
order record shows.

This job never repairs the mapping. It reports drift per product_id, and for
orders still Incomplete or Pending with unassigned quantity, it can flag the
order for manual verification (status_id 12) so a human reviews it before it
ships. Consignments only exist pre-conversion on the checkout object; once an
order has converted, the only real fixes are cancelling and refunding the
order for a re-checkout, or a manual merchant edit in the control panel.

Guide: https://www.allanninal.dev/bigcommerce/multi-address-checkout-consignment-drift/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_consignment_drift")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

MANUAL_VERIFICATION_REQUIRED = 12
OPEN_STATUS_IDS = {0, 1}  # Incomplete, Pending

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


def find_consignment_drift(consignments: list, order_products: list) -> list:
    """Pure decision. No network, no side effects.

    consignments: pre-conversion checkout consignments, each
        {"consignment_id": str, "line_items": [{"item_id": str, "quantity": int}], "address_id": str}
    order_products: post-conversion order line items from GET /v2/orders/{id}/products, each
        {"id": int, "product_id": int, "quantity": int, "order_address_id": int}

    Returns a list of drift records, one per product_id, of shape:
        {"product_id": int, "expected_qty": int, "actual_qty": int,
         "unassigned_qty": int, "duplicated_qty": int, "status": "unassigned"|"duplicated"|"ok"}

    expected_qty is the sum of quantity across all consignment line_items for
    that item_id (item_id maps 1:1 to product_id in this store's checkout
    flow). actual_qty is the sum of quantity across all order_products rows
    for that product_id. unassigned_qty is the portion of actual_qty whose
    order_address_id is 0 or None, meaning it was never bound to any of the
    shipping addresses created for the order. duplicated_qty is
    max(0, actual_qty - expected_qty) when actual_qty exceeds expected_qty.
    status is "unassigned" if unassigned_qty > 0, else "duplicated" if
    actual_qty != expected_qty and duplicated_qty > 0, else "ok". Callers
    should pass only physical line items in order_products so digital,
    non-shippable products (order_address_id 0 by design) do not produce
    false positives.
    """
    expected_qty = {}
    for consignment in consignments or []:
        for line_item in consignment.get("line_items", []) or []:
            product_id = line_item["item_id"]
            expected_qty[product_id] = expected_qty.get(product_id, 0) + line_item.get("quantity", 0)

    actual_qty = {}
    unassigned_qty = {}
    for row in order_products or []:
        product_id = row["product_id"]
        qty = row.get("quantity", 0)
        actual_qty[product_id] = actual_qty.get(product_id, 0) + qty

        order_address_id = row.get("order_address_id")
        if order_address_id in (0, None):
            unassigned_qty[product_id] = unassigned_qty.get(product_id, 0) + qty

    product_ids = set(expected_qty) | set(actual_qty)
    drift = []
    for product_id in sorted(product_ids):
        expected = expected_qty.get(product_id, 0)
        actual = actual_qty.get(product_id, 0)
        unassigned = unassigned_qty.get(product_id, 0)
        duplicated = (actual - expected) if actual > expected else 0

        if unassigned > 0:
            status = "unassigned"
        elif actual != expected and duplicated > 0:
            status = "duplicated"
        else:
            status = "ok"

        drift.append({
            "product_id": product_id,
            "expected_qty": expected,
            "actual_qty": actual,
            "unassigned_qty": unassigned,
            "duplicated_qty": duplicated,
            "status": status,
        })
    return drift


def candidate_orders():
    """Page through orders within the lookback window."""
    page = 1
    while True:
        orders = bc_get(
            API_BASE_V2,
            "/orders",
            {"min_date_created": f"-{LOOKBACK_DAYS} days", "page": page, "limit": 50},
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_shipping_addresses(order_id):
    return bc_get(API_BASE_V2, f"/orders/{order_id}/shipping_addresses")


def order_products(order_id):
    return bc_get(API_BASE_V2, f"/orders/{order_id}/products")


def checkout_consignments(checkout_id):
    payload = bc_get(API_BASE_V3, f"/checkouts/{checkout_id}/consignments")
    return payload.get("data", []) if isinstance(payload, dict) else payload


def flag_for_manual_verification(order_id):
    return bc_put(API_BASE_V2, f"/orders/{order_id}", {"status_id": MANUAL_VERIFICATION_REQUIRED})


def run():
    reported = 0
    flagged = 0

    for order in candidate_orders():
        order_id = order["id"]
        status_id = order.get("status_id")

        addresses = order_shipping_addresses(order_id)
        if len(addresses) < 2:
            continue  # not a multi-address order, nothing to reconcile

        products = order_products(order_id)
        checkout_id = order.get("checkout_id")
        consignments = checkout_consignments(checkout_id) if checkout_id else []

        drift = find_consignment_drift(consignments, products)
        problems = [d for d in drift if d["status"] != "ok"]
        if not problems:
            continue

        reported += 1
        for record in problems:
            log.warning(
                "order_id=%s product_id=%s status=%s expected_qty=%s actual_qty=%s "
                "unassigned_qty=%s duplicated_qty=%s",
                order_id, record["product_id"], record["status"], record["expected_qty"],
                record["actual_qty"], record["unassigned_qty"], record["duplicated_qty"],
            )

        has_unassigned = any(d["unassigned_qty"] > 0 for d in problems)
        if has_unassigned and status_id in OPEN_STATUS_IDS:
            log.info(
                "order_id=%s eligible for manual verification flag (%s)",
                order_id, "dry run" if DRY_RUN else "flagging",
            )
            if not DRY_RUN:
                flag_for_manual_verification(order_id)
            flagged += 1

    log.info(
        "Done. %d order(s) with drift, %d order(s) %s for manual verification.",
        reported, flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
