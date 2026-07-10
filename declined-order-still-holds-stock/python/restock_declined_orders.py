"""Restock BigCommerce Declined orders whose stock was never returned.

BigCommerce debits inventory_level at order creation, and only returns it when
the order reaches a status your Inventory Settings map to "return stock",
typically Cancelled or Refunded. Declined (status_id 6) is often not covered,
so the debited stock sits withheld from real buyers. This lists recently
Declined orders, confirms with GET /v2/orders/{id}/transactions that nothing
was actually approved or captured, and returns each line item's quantity with
POST /v3/inventory/adjustments/relative. Orders with real money behind them
are flagged for a human instead of auto-restocked. Guarded by DRY_RUN. Safe to
run again and again.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restock_declined_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE_URL = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
LOOKBACK_DAYS = int(os.environ.get("RESTOCK_LOOKBACK_DAYS", "3"))
LOCATION_ID = int(os.environ.get("LOCATION_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DECLINED_STATUS_ID = 6
CHARGED_STATUSES = {"approved", "captured"}
ADJUSTED_NOTE = "declined-order-restocked-by-script"


def _headers():
    return {
        "X-Auth-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def decide_restock(order: dict, transactions: list) -> dict:
    """Pure decision function. No network calls.

    order: {"status_id": int, "products": list[{"variant_id", "sku", "quantity"}],
            "already_adjusted": bool}
    transactions: list[{"status": str}]

    Returns {"action": "restock" | "flag" | "skip", "items": list[{"variant_id", "qty"}]}.

    Only Declined orders (status_id == 6) are candidates. An order already marked
    adjusted is skipped so a second run never double-restocks it. If any
    transaction shows an approved or captured status, money moved despite the
    Declined status, so the order is flagged for a human instead of touched.
    Otherwise every line item's quantity is queued to be added back.
    """
    if order["status_id"] != DECLINED_STATUS_ID:
        return {"action": "skip", "items": []}
    if order.get("already_adjusted"):
        return {"action": "skip", "items": []}
    if any(t.get("status") in CHARGED_STATUSES for t in transactions):
        return {"action": "flag", "items": []}
    items = [{"variant_id": p["variant_id"], "qty": p["quantity"]} for p in order["products"]]
    return {"action": "restock", "items": items}


def declined_orders():
    """Yield candidate orders with status_id 6 modified within the lookback window."""
    since = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).strftime(
        "%a, %d %b %Y %H:%M:%S +0000"
    )
    page = 1
    limit = 50
    while True:
        r = requests.get(
            BASE_URL + "v2/orders",
            headers=_headers(),
            params={
                "status_id": DECLINED_STATUS_ID,
                "min_date_modified": since,
                "limit": limit,
                "page": page,
            },
            timeout=30,
        )
        if r.status_code == 204:
            return
        r.raise_for_status()
        orders = r.json()
        if not orders:
            return
        for order in orders:
            yield order
        if len(orders) < limit:
            return
        page += 1


def get_order_products(order_id):
    r = requests.get(BASE_URL + f"v2/orders/{order_id}/products", headers=_headers(), timeout=30)
    if r.status_code == 204:
        return []
    r.raise_for_status()
    products = r.json() or []
    return [{"variant_id": p["variant_id"], "sku": p.get("sku"), "quantity": p["quantity"]} for p in products]


def get_order_transactions(order_id):
    r = requests.get(BASE_URL + f"v2/orders/{order_id}/transactions", headers=_headers(), timeout=30)
    if r.status_code == 204:
        return []
    r.raise_for_status()
    return r.json() or []


def get_order_notes(order_id):
    r = requests.get(BASE_URL + f"v2/orders/{order_id}/notes", headers=_headers(), timeout=30)
    if r.status_code == 204:
        return []
    r.raise_for_status()
    return r.json() or []


def is_already_adjusted(order_id):
    return any(ADJUSTED_NOTE in (n.get("note") or "") for n in get_order_notes(order_id))


def restock_items(items, location_id):
    payload = {
        "reason": "Declined order restock reconciliation",
        "location_id": location_id,
        "items": [{"variant_id": i["variant_id"], "quantity": i["qty"]} for i in items],
    }
    r = requests.post(
        BASE_URL + "v3/inventory/adjustments/relative",
        headers=_headers(),
        json=payload,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def mark_adjusted(order_id):
    r = requests.post(
        BASE_URL + f"v2/orders/{order_id}/notes",
        headers=_headers(),
        json={"note": ADJUSTED_NOTE},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    restocked = 0
    flagged = 0
    for order in declined_orders():
        order_id = order["id"]
        full_order = {
            "status_id": order.get("status_id", DECLINED_STATUS_ID),
            "products": get_order_products(order_id),
            "already_adjusted": is_already_adjusted(order_id),
        }
        transactions = get_order_transactions(order_id)
        decision = decide_restock(full_order, transactions)

        if decision["action"] == "skip":
            continue

        if decision["action"] == "flag":
            log.warning(
                "Order %s Declined but has approved/captured transactions. Flagged for manual review.",
                order_id,
            )
            flagged += 1
            continue

        log.info(
            "Order %s eligible to restock %d item(s). %s",
            order_id,
            len(decision["items"]),
            "would restock" if DRY_RUN else "restocking",
        )
        if not DRY_RUN:
            restock_items(decision["items"], LOCATION_ID)
            mark_adjusted(order_id)
        restocked += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for review.",
        restocked,
        "to restock" if DRY_RUN else "restocked",
        flagged,
    )


if __name__ == "__main__":
    run()
