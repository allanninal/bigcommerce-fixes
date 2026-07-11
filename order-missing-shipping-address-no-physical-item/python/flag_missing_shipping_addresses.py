"""Flag BigCommerce orders with a physical line item but no shipping address.

BigCommerce only writes a shipping_addresses record on an order when the cart
that produced it contained at least one line item whose product type is
physical. An order made up entirely of digital line items, downloads,
services, or gift certificates never gets one, and GET
/v2/orders/{id}/shipping_addresses legitimately returns an empty array for
that order. That is expected behavior, not a bug. The real anomaly is a
physical line item with no address on file, most often caused by a custom or
headless checkout integration that created the order via the API and skipped
submitting consignments. This job audits a list of orders, resolves each line
item's product type, and flags only the orders where a physical item shipped
with no shipping address and the order is in a real post-checkout status.
There is no API to retroactively attach a real shipping address, so the only
write action is a staff_notes annotation, guarded by DRY_RUN. Safe to run
again and again.

Guide: https://www.allanninal.dev/bigcommerce/order-missing-shipping-address-no-physical-item/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_missing_shipping_addresses")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EXCLUDED_STATUS_IDS = {0, 5, 6}
FLAG_NOTE = "missing shipping address - needs manual review"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get_v2(path, params=None):
    r = requests.get(f"{API_V2}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else []


def bc_get_v3(path, params=None):
    r = requests.get(f"{API_V3}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    body = r.json()
    return body.get("data", body)


def bc_put_v2(path, body):
    r = requests.put(f"{API_V2}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def classify_shipping_address_gap(
    status_id: int, line_item_types: list, has_shipping_address: bool
) -> str:
    """Pure decision. No network, no side effects.

    Takes the order's status_id, a list of each line item's resolved product
    type string ("physical"/"digital"), and whether shipping_addresses was
    non-empty. Returns one of:

      ok_digital_only        - no physical items, no address expected.
      ok_has_address          - shipping_addresses is non-empty.
      ok_excluded_status      - status_id in {0, 5, 6}, absence is inconclusive.
      anomaly_missing_address - post-checkout status, a physical item is
                                present, and no shipping address exists.
    """
    if status_id in EXCLUDED_STATUS_IDS:
        return "ok_excluded_status"

    if has_shipping_address:
        return "ok_has_address"

    has_physical_item = any(t == "physical" for t in line_item_types)
    if not has_physical_item:
        return "ok_digital_only"

    return "anomaly_missing_address"


def orders_to_audit():
    """Page through orders created within the lookback window."""
    page = 1
    while True:
        orders = bc_get_v2(
            "/orders",
            {
                "min_date_created": f"-{LOOKBACK_DAYS} days",
                "page": page,
                "limit": 50,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_line_items(order_id):
    return bc_get_v2(f"/orders/{order_id}/products")


def order_shipping_addresses(order_id):
    return bc_get_v2(f"/orders/{order_id}/shipping_addresses")


def resolve_product_type(product_id, cache):
    if product_id in cache:
        return cache[product_id]
    try:
        product = bc_get_v3(f"/catalog/products/{product_id}")
        value = product.get("type", "physical")
    except requests.HTTPError:
        # A deleted or inaccessible product is treated as physical, the
        # conservative choice, so a real anomaly is never silently dropped.
        value = "physical"
    cache[product_id] = value
    return value


def flag_order_for_review(order_id, existing_notes=""):
    notes = (existing_notes or "").strip()
    if FLAG_NOTE in notes:
        return None
    merged = f"{notes}\n{FLAG_NOTE}".strip() if notes else FLAG_NOTE
    return bc_put_v2(f"/orders/{order_id}", {"staff_notes": merged})


def run():
    product_type_cache = {}
    anomalies = 0
    digital_only = 0

    for order in orders_to_audit():
        order_id = order["id"]
        status_id = order.get("status_id")

        line_items = order_line_items(order_id)
        product_ids = sorted({item["product_id"] for item in line_items or [] if item.get("product_id")})
        line_item_types = [resolve_product_type(pid, product_type_cache) for pid in product_ids]

        shipping_addresses = order_shipping_addresses(order_id)
        has_shipping_address = bool(shipping_addresses)

        classification = classify_shipping_address_gap(status_id, line_item_types, has_shipping_address)

        if classification == "ok_digital_only":
            digital_only += 1
            log.info(
                "order_id=%s status_id=%s ok_digital_only (no address expected)",
                order_id, status_id,
            )
            continue

        if classification != "anomaly_missing_address":
            continue

        physical_product_ids = [
            pid for pid, t in zip(product_ids, line_item_types) if t == "physical"
        ]
        customer_id = order.get("customer_id")

        log.warning(
            "anomaly_missing_address order_id=%s status_id=%s physical_product_ids=%s "
            "customer_id=%s (%s)",
            order_id, status_id, physical_product_ids, customer_id,
            "dry run" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_order_for_review(order_id, order.get("staff_notes", ""))
        anomalies += 1

    log.info(
        "Done. %d anomal%s found, %d digital-only order(s) logged for visibility.",
        anomalies, "y" if anomalies == 1 else "ies", digital_only,
    )


if __name__ == "__main__":
    run()
