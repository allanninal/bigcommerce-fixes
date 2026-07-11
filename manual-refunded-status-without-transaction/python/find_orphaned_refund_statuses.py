"""Find BigCommerce orders marked Refunded or Partially Refunded with no real refund behind them.

BigCommerce treats order status and money movement as two decoupled systems. The
status_id field is just a label on the order record, and PUT /v2/orders/{id} will
accept status_id 4 (Refunded) or 14 (Partially Refunded) with no side effect at all.
Real refunds only happen through the Payment Actions workflow, refund_quotes then
refunds, which calls the gateway and, only on success, writes a transaction and
updates status as a result. Staff using the Edit status dropdown instead of the
Refund action, or an integration that PUTs status_id 4 directly to mirror an
external refund, both leave the order showing Refunded with zero refund
transactions behind it. This job lists candidate orders at status_id 4 and 14,
reads each order's transactions, and reports every order where no refund-type
transaction exists and refunded_amount is still 0.00. There is no API to
retroactively attach a real refund to an order, so this never auto-repairs.
With DRY_RUN=false it additionally fetches a refund quote and prints the exact
refund request an operator would need to review and submit by hand. It never
calls the real refunds endpoint itself. Run on a schedule. Safe to run again
and again.

Guide: https://www.allanninal.dev/bigcommerce/manual-refunded-status-without-transaction/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_refund_statuses")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
V2_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
V3_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REFUNDED = 4
PARTIALLY_REFUNDED = 14
REFUND_STATUS_IDS = {REFUNDED, PARTIALLY_REFUNDED}
AMOUNT_EPSILON = 0.01

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


def bc_post(base, path, body):
    r = requests.post(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    if not r.text:
        return {}
    return r.json()


def is_orphaned_refund_status(
    status_id: int, transactions: list, refunded_amount: str, total_inc_tax: str
) -> bool:
    """Pure decision logic (no I/O). status_id from BigCommerce order (int, e.g.
    4=Refunded, 14=Partially Refunded).

    transactions: list of dicts from GET /v2/orders/{id}/transactions, each with
    a 'type' (or 'event') key. refunded_amount / total_inc_tax: decimal strings
    from the order resource.

    Returns True if the order is marked Refunded/Partially Refunded but has no
    matching refund transaction record and/or refunded_amount does not reflect
    any actual refund (i.e. still 0.00), meaning status was changed manually
    with no money movement.
    """
    if status_id not in REFUND_STATUS_IDS:
        return False

    has_refund_txn = False
    refund_txn_total = 0.0
    for txn in transactions or []:
        kind = (txn.get("type") or txn.get("event") or "").lower()
        if kind != "refund":
            continue
        try:
            amount = float(txn.get("amount"))
        except (TypeError, ValueError):
            amount = 0.0
        if amount > 0:
            has_refund_txn = True
            refund_txn_total += amount

    try:
        recorded_refund = float(refunded_amount)
    except (TypeError, ValueError):
        recorded_refund = 0.0

    no_recorded_refund = recorded_refund < AMOUNT_EPSILON

    return (not has_refund_txn) and no_recorded_refund and refund_txn_total < AMOUNT_EPSILON


def candidate_orders(status_id):
    """Page through orders currently at the given refund-ish status_id."""
    page = 1
    while True:
        orders = bc_get(
            V2_BASE,
            "/orders",
            {
                "status_id": status_id,
                "min_date_modified": f"-{LOOKBACK_DAYS} days",
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
    return bc_get(V2_BASE, f"/orders/{order_id}/transactions")


def order_payment_action_refunds(order_id):
    result = bc_get(V3_BASE, f"/orders/{order_id}/payment_actions/refunds")
    return result.get("data", []) if isinstance(result, dict) else []


def fetch_refund_quote(order_id):
    """Fetch a refund quote from BigCommerce. Never submits the refund itself."""
    return bc_post(V3_BASE, f"/orders/{order_id}/payment_actions/refund_quotes", {})


def build_report_row(order, transactions):
    return {
        "order_id": order["id"],
        "status_id": order.get("status_id"),
        "total_inc_tax": order.get("total_inc_tax"),
        "refunded_amount": order.get("refunded_amount"),
        "transaction_count": len(transactions or []),
    }


def run():
    orphaned = 0
    for status_id in (REFUNDED, PARTIALLY_REFUNDED):
        for order in candidate_orders(status_id):
            order_id = order["id"]
            transactions = order_transactions(order_id)
            payment_action_refunds = order_payment_action_refunds(order_id)

            orphaned_flag = is_orphaned_refund_status(
                order.get("status_id"),
                transactions,
                order.get("refunded_amount"),
                order.get("total_inc_tax"),
            )
            if not orphaned_flag:
                continue
            if payment_action_refunds:
                # BigCommerce's own Payment Actions history disagrees with the
                # transactions read; still worth a human look, but log distinctly.
                log.warning(
                    "Order %s has payment_actions/refunds history but no matching "
                    "transaction entry, needs manual review.", order_id,
                )

            row = build_report_row(order, transactions)
            log.warning(
                "ORPHANED REFUND STATUS order_id=%s status_id=%s total_inc_tax=%s "
                "refunded_amount=%s transaction_count=%s",
                row["order_id"], row["status_id"], row["total_inc_tax"],
                row["refunded_amount"], row["transaction_count"],
            )
            orphaned += 1

            if not DRY_RUN:
                quote = fetch_refund_quote(order_id)
                log.info(
                    "Refund quote fetched for order_id=%s. To submit, an operator "
                    "must POST %s/orders/%s/payment_actions/refunds with body: %s",
                    order_id, V3_BASE, order_id, quote,
                )

    log.info("Done. %d order(s) flagged as orphaned Refunded status.", orphaned)


if __name__ == "__main__":
    run()
