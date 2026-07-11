"""Flag BigCommerce orders created via API that bypassed group and price list pricing.

POST /v2/orders is a back-office order-entry endpoint, not the storefront checkout
pricing engine. It only runs a cart through the pricing service if the caller omits
price fields entirely. When an integration supplies price_inc_tax/price_ex_tax on
each line, exactly what "pre-resolving" price client-side produces, BigCommerce
takes that number as authoritative and never resolves it against the customer's
assigned Price List or customer-group discount rules. Because the order has no
cart_id tying it back to a priced cart, there is no signal the submitted price is
stale or wrong. This job scans recent orders, resolves each customer's assigned
price list, and flags any line billed at plain catalog price (or any other price)
when the price list disagrees. It never rewrites a placed order's price fields; it
only cancels an unpaid order with no captured transaction, or reports a delta for a
human to refund or credit. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/api-order-bypasses-group-pricing/
"""
import os
import logging
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_order_pricing")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
V2_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
V3_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
CHANNEL_ID = int(os.environ.get("CHANNEL_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

UNPAID_STATUS_IDS = {0, 7, 11}
API_CREATION_WINDOW_STATUS_IDS = {0, 7, 9, 11}
CANCELLED = 5

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get_v2(path, params=None):
    r = requests.get(f"{V2_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else []


def bc_put_v2(path, body):
    r = requests.put(f"{V2_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_get_v3(path, params=None):
    r = requests.get(f"{V3_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {"data": []}


def diagnose_order_line_pricing(
    customer_group_id,
    assigned_price_list_id,
    price_list_record_price_ex_tax,
    catalog_price_ex_tax,
    billed_price_ex_tax,
    order_status_id,
    has_captured_transaction,
):
    """Pure decision logic, no I/O. All prices passed as decimal strings, compared via Decimal.

    Returns {"flagged": bool, "reason": str, "delta_ex_tax": str, "recommended_action": str}.
    If no assigned_price_list_id or no price_list_record_price_ex_tax: not flagged, the
    customer has no price-list override, so plain catalog price is correct.
    If billed_price_ex_tax == price_list_record_price_ex_tax: not flagged, correctly priced.
    If billed_price_ex_tax == catalog_price_ex_tax and price list disagrees with catalog:
    flagged, reason='billed_at_catalog_price_ignoring_pricelist'.
    Otherwise: flagged, reason='billed_price_mismatch_unknown_source'.
    recommended_action is 'cancel_unpaid' when order_status_id is in {0, 7, 11} and there
    is no captured transaction, else 'report_refund_delta'.
    """
    if assigned_price_list_id is None or price_list_record_price_ex_tax is None:
        return {
            "flagged": False,
            "reason": "no_price_list_assigned",
            "delta_ex_tax": "0",
            "recommended_action": "none",
        }

    try:
        list_price = Decimal(price_list_record_price_ex_tax)
        billed = Decimal(billed_price_ex_tax)
        catalog = Decimal(catalog_price_ex_tax)
    except (InvalidOperation, TypeError):
        return {
            "flagged": True,
            "reason": "billed_price_mismatch_unknown_source",
            "delta_ex_tax": "0",
            "recommended_action": "report_refund_delta",
        }

    if billed == list_price:
        return {
            "flagged": False,
            "reason": "correctly_priced",
            "delta_ex_tax": "0",
            "recommended_action": "none",
        }

    unpaid = order_status_id in UNPAID_STATUS_IDS and not has_captured_transaction
    action = "cancel_unpaid" if unpaid else "report_refund_delta"

    if billed == catalog and list_price != catalog:
        return {
            "flagged": True,
            "reason": "billed_at_catalog_price_ignoring_pricelist",
            "delta_ex_tax": str(list_price - billed),
            "recommended_action": action,
        }

    return {
        "flagged": True,
        "reason": "billed_price_mismatch_unknown_source",
        "delta_ex_tax": str(list_price - billed),
        "recommended_action": action,
    }


def candidate_orders():
    """Page through orders in the API-creation status window within the lookback window."""
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
            if order.get("status_id") in API_CREATION_WINDOW_STATUS_IDS:
                yield order
        page += 1


def order_products(order_id):
    return bc_get_v2(f"/orders/{order_id}/products")


def order_has_captured_transaction(order_id):
    transactions = bc_get_v2(f"/orders/{order_id}/transactions")
    for txn in transactions or []:
        kind = (txn.get("type") or txn.get("event") or "").lower()
        status = (txn.get("status") or "").lower()
        if kind in {"capture", "sale"} and status == "success":
            return True
    return False


def customer_group_id(customer_id):
    if not customer_id:
        return None
    data = bc_get_v3("/customers", {"id:in": customer_id})
    rows = data.get("data") or []
    return rows[0]["customer_group_id"] if rows else None


def assigned_price_list_id(customer_group_id_value):
    if not customer_group_id_value:
        return None
    data = bc_get_v3(
        "/pricelists/assignments",
        {"customer_group_id": customer_group_id_value, "channel_id": CHANNEL_ID},
    )
    rows = data.get("data") or []
    return rows[0]["price_list_id"] if rows else None


def price_list_record_price(price_list_id, variant_id):
    if not price_list_id:
        return None
    data = bc_get_v3(f"/pricelists/{price_list_id}/records", {"variant_id:in": variant_id})
    rows = data.get("data") or []
    return rows[0].get("price_ex_tax") if rows else None


def catalog_variant_price(product_id, variant_id):
    data = bc_get_v3(f"/catalog/products/{product_id}/variants/{variant_id}")
    row = data.get("data") or {}
    price = row.get("price")
    return str(price) if price is not None else None


def run():
    flagged_count = 0
    cancelled_count = 0

    for order in candidate_orders():
        order_id = order["id"]
        customer_id = order.get("customer_id")
        status_id = order.get("status_id")

        group_id = customer_group_id(customer_id)
        price_list_id = assigned_price_list_id(group_id)

        if price_list_id is None:
            continue

        has_captured = order_has_captured_transaction(order_id)

        for line in order_products(order_id) or []:
            product_id = line.get("product_id")
            variant_id = line.get("variant_id")
            billed = line.get("price_ex_tax")

            list_price = price_list_record_price(price_list_id, variant_id)
            catalog_price = catalog_variant_price(product_id, variant_id)

            result = diagnose_order_line_pricing(
                group_id, price_list_id, list_price, catalog_price, billed, status_id, has_captured
            )

            if not result["flagged"]:
                continue

            flagged_count += 1
            log.warning(
                "order_id=%s product_id=%s variant_id=%s billed=%s list_price=%s "
                "catalog_price=%s reason=%s delta=%s action=%s",
                order_id, product_id, variant_id, billed, list_price,
                catalog_price, result["reason"], result["delta_ex_tax"], result["recommended_action"],
            )

            if result["recommended_action"] == "cancel_unpaid":
                if not DRY_RUN:
                    bc_put_v2(f"/orders/{order_id}", {"status_id": CANCELLED})
                cancelled_count += 1

    log.info(
        "Done. %d line(s) flagged, %d order(s) %s for cancellation.",
        flagged_count, cancelled_count, "to cancel" if DRY_RUN else "cancelled",
    )


if __name__ == "__main__":
    run()
