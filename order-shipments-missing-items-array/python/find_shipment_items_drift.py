"""Find BigCommerce order shipments whose items array was dropped by a mapper.

BigCommerce's V2 shipment object, from GET /v2/orders/{order_id}/shipments,
nests the shipped order lines inside an items array of order_product_id,
product_id, and quantity, alongside flat scalar fields like tracking_number
and order_address_id. Client integrations that map the response through a
fixed schema, a typed model or DTO, or a column-style allowlist built for the
common scalar fields can easily leave items out, since it is a nested array
and not a top-level scalar. The mapped object then shows items as missing,
null, or an empty list even though the raw JSON body still has the shipped
lines. This is a client-side parsing defect, not corrupted BigCommerce data,
so this job never writes to the shipment. It only reports the drift and,
when DRY_RUN is false, cross-checks the raw shipped quantities against
GET /v2/orders/{order_id}/products to confirm the shipped lines are real.

Guide: https://www.allanninal.dev/bigcommerce/order-shipments-missing-items-array/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_shipment_items_drift")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

# Stand-in for a narrow scalar-only mapper that omits the nested items array.
# Replace this with your real SDK/DTO mapping when wiring this into your own
# integration; the point of the reconciler is to compare THAT output against
# the raw JSON body BigCommerce actually sent.
SCALAR_FIELDS = (
    "id", "order_id", "customer_id", "order_address_id",
    "date_created", "tracking_number", "shipping_provider",
    "tracking_carrier", "comments",
)


def bc_get_raw(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def order_shipments(order_id):
    return bc_get_raw(f"/orders/{order_id}/shipments")


def order_products(order_id):
    return bc_get_raw(f"/orders/{order_id}/products")


def map_shipment_scalars_only(raw_shipment):
    """Reproduce a scalar-only mapper that forgets the nested items array."""
    return {key: raw_shipment.get(key) for key in SCALAR_FIELDS}


def find_items_drift(raw_shipment: dict, mapped_shipment: dict) -> dict | None:
    """Pure decision logic, no I/O.

    raw_shipment: parsed JSON body of a single V2 shipment as returned by
                  GET /stores/{store_hash}/v2/orders/{order_id}/shipments/{shipment_id}
    mapped_shipment: the same shipment after passing through the client
                  library/ORM mapper (dict-like view of its attributes)
    Returns a drift record if the mapper dropped/emptied a non-empty raw
    'items' array, else None.
    """
    raw_items = raw_shipment.get("items") or []
    mapped_items = mapped_shipment.get("items")
    if not isinstance(raw_items, list) or len(raw_items) == 0:
        return None  # nothing shipped in raw; not a drift case
    if mapped_items is None or mapped_items == [] or not isinstance(mapped_items, list):
        raw_qty = sum(int(i.get("quantity", 0)) for i in raw_items)
        return {
            "shipment_id": raw_shipment.get("id"),
            "order_id": raw_shipment.get("order_id"),
            "raw_item_count": len(raw_items),
            "raw_shipped_quantity": raw_qty,
            "mapped_items_value": mapped_items,
            "order_product_ids": [i.get("order_product_id") for i in raw_items],
        }
    return None


def cross_check_quantity_shipped(order_id, order_product_ids):
    """Confirm shipped quantities against order-products' quantity_shipped."""
    products = order_products(order_id)
    by_id = {p.get("id"): p.get("quantity_shipped") for p in products}
    return {opid: by_id.get(opid) for opid in order_product_ids}


def run(order_ids):
    drift_count = 0
    for order_id in order_ids:
        raw_shipments = order_shipments(order_id)
        for raw_shipment in raw_shipments or []:
            mapped_shipment = map_shipment_scalars_only(raw_shipment)
            drift = find_items_drift(raw_shipment, mapped_shipment)
            if drift is None:
                continue

            drift_count += 1
            log.warning(
                "Drift found: shipment_id=%s order_id=%s raw_item_count=%s "
                "raw_shipped_quantity=%s mapped_items_value=%r",
                drift["shipment_id"], drift["order_id"], drift["raw_item_count"],
                drift["raw_shipped_quantity"], drift["mapped_items_value"],
            )

            if not DRY_RUN:
                confirmed = cross_check_quantity_shipped(order_id, drift["order_product_ids"])
                log.info(
                    "Cross-check for shipment_id=%s order_id=%s quantity_shipped=%s",
                    drift["shipment_id"], drift["order_id"], confirmed,
                )

    log.info("Done. %d shipment(s) with dropped items array.", drift_count)


if __name__ == "__main__":
    order_ids_env = os.environ.get("ORDER_IDS", "")
    order_ids = [int(x) for x in order_ids_env.split(",") if x.strip()]
    run(order_ids)
