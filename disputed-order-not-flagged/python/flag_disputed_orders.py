"""Flag BigCommerce orders that were disputed at the gateway but never marked Disputed.

A chargeback happens between the customer's bank, the card network, and the
payment gateway. BigCommerce is not part of that conversation, so an order's
status_id only reaches 13 (Disputed) if a webhook happens to arrive and a
listener happens to catch it, or a person opens the order and sets it by hand.
Many gateways never send that event to BigCommerce at all, so a genuinely
disputed order can sit at its old status indefinitely while the payout is
already being reduced. This job lists recent orders, reads each order's
transactions, and flags only the ones with a clear dispute or chargeback
marker in a transaction's type or status, skipping any order already in a
settled status such as Disputed, Refunded, Cancelled, or Partially Refunded.
It never touches refunds, cancellations, or fulfillment. Run on a schedule.
Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/disputed-order-not-flagged/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_disputed_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DISPUTED = 13
SETTLED_STATUSES = {13, 4, 5, 14}  # Disputed, Refunded, Cancelled, Partially Refunded
DISPUTE_MARKERS = {"chargeback", "dispute", "disputed"}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def needs_dispute_flag(status_id, transactions):
    """Pure decision. No network, no side effects.

    An order already sitting in a settled status (Disputed, Refunded,
    Cancelled, Partially Refunded) is left alone, since that status already
    reflects an outcome. Otherwise, scan the order's own transactions for a
    type or status that clearly reads as a dispute or chargeback. Any match
    means the order needs a flag.
    """
    if status_id in SETTLED_STATUSES:
        return False

    for txn in transactions or []:
        txn_kind = (txn.get("type") or txn.get("event") or "").lower()
        txn_status = (txn.get("status") or "").lower()
        if any(marker in txn_kind or marker in txn_status for marker in DISPUTE_MARKERS):
            return True
    return False


def recent_orders():
    """Page through orders created within the lookback window."""
    page = 1
    while True:
        orders = bc_get(
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


def order_transactions(order_id):
    return bc_get(f"/orders/{order_id}/transactions")


def flag_disputed(order_id):
    return bc_put(f"/orders/{order_id}", {"status_id": DISPUTED})


def run():
    flagged = 0
    for order in recent_orders():
        order_id = order["id"]
        status_id = order.get("status_id")
        transactions = order_transactions(order_id)

        if not needs_dispute_flag(status_id, transactions):
            continue

        matching_txn = None
        for txn in transactions or []:
            txn_kind = (txn.get("type") or txn.get("event") or "").lower()
            txn_status = (txn.get("status") or "").lower()
            if any(marker in txn_kind or marker in txn_status for marker in DISPUTE_MARKERS):
                matching_txn = txn
                break

        log.warning(
            "order_id=%s current_status_id=%s transaction_id=%s transaction_type=%s %s",
            order_id, status_id,
            matching_txn.get("id") if matching_txn else None,
            matching_txn.get("type") if matching_txn else None,
            "would flag as Disputed" if DRY_RUN else "flagging as Disputed",
        )
        if not DRY_RUN:
            flag_disputed(order_id)
        flagged += 1

    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
