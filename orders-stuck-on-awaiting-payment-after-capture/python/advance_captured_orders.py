"""Advance BigCommerce orders that were captured but never left Awaiting Payment.

BigCommerce order status and payment status are decoupled from the real gateway
transaction. When a payment is authorize only, capturing it (by hand or with the
Capture Order Payment action) sets payment_status to Pending Capture while the
capture is processed out of band by the gateway. If the confirmation callback is
slow, silently fails, or the merchant captures directly in the gateway's own
dashboard, the order record never gets the follow up update and status_id stays
at 7 (Awaiting Payment) even though the transaction and the gateway both show the
money was captured. This job lists candidate orders at status_id 7, reads each
order's transactions, and advances only the ones with an unambiguous successful
capture or sale transaction whose amount matches the order total. Anything else
is flagged for manual review, never auto-advanced. Run on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/bigcommerce/orders-stuck-on-awaiting-payment-after-capture/
"""
import os
import logging
from typing import Literal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("advance_captured_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

AWAITING_PAYMENT = 7
AWAITING_FULFILLMENT = 11

CAPTURE_TYPES = {"capture", "sale"}
AMOUNT_EPSILON = 0.01

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


def decide_order_repair(
    status_id: int, transactions: list, order_total: str
) -> Literal["advance_to_awaiting_fulfillment", "flag_for_review", "no_action"]:
    """Pure decision. No network, no side effects.

    if status_id != 7: no_action.
    Find capture/sale transactions with status "success" and amount matching
    order_total within a currency-aware epsilon. If at least one matches,
    advance_to_awaiting_fulfillment. If a capture transaction exists but is
    pending, declined, or amount mismatched, flag_for_review. If there is no
    capture-type transaction at all, no_action (genuinely unpaid).
    """
    if status_id != AWAITING_PAYMENT:
        return "no_action"

    try:
        total = float(order_total)
    except (TypeError, ValueError):
        total = None

    saw_capture_type = False
    has_matching_success = False
    has_problem_capture = False

    for txn in transactions or []:
        txn_kind = (txn.get("type") or txn.get("event") or "").lower()
        if txn_kind not in CAPTURE_TYPES:
            continue
        saw_capture_type = True

        txn_status = (txn.get("status") or "").lower()
        try:
            amount = float(txn.get("amount"))
        except (TypeError, ValueError):
            amount = None

        amount_matches = (
            total is not None and amount is not None and abs(amount - total) < AMOUNT_EPSILON
        )

        if txn_status == "success" and amount_matches:
            has_matching_success = True
        else:
            has_problem_capture = True

    if has_matching_success:
        return "advance_to_awaiting_fulfillment"
    if saw_capture_type and has_problem_capture:
        return "flag_for_review"
    return "no_action"


def candidate_orders():
    """Page through orders currently at Awaiting Payment (status_id 7)."""
    page = 1
    while True:
        orders = bc_get(
            "/orders",
            {
                "status_id": AWAITING_PAYMENT,
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


def advance_order(order_id):
    return bc_put(f"/orders/{order_id}", {"status_id": AWAITING_FULFILLMENT})


def run():
    advanced = 0
    flagged = 0
    for order in candidate_orders():
        order_id = order["id"]
        order_total = order.get("total_inc_tax") or order.get("total_ex_tax") or "0"
        transactions = order_transactions(order_id)

        decision = decide_order_repair(order.get("status_id"), transactions, order_total)

        if decision == "no_action":
            continue

        if decision == "flag_for_review":
            log.warning(
                "Order %s flagged for review. total=%s status_id=%s",
                order_id, order_total, order.get("status_id"),
            )
            flagged += 1
            continue

        gateway = None
        gateway_transaction_id = None
        transaction_id = None
        for txn in transactions or []:
            txn_kind = (txn.get("type") or txn.get("event") or "").lower()
            if txn_kind in CAPTURE_TYPES and (txn.get("status") or "").lower() == "success":
                gateway = txn.get("gateway")
                gateway_transaction_id = txn.get("gateway_transaction_id")
                transaction_id = txn.get("id")
                break

        log.info(
            "order_id=%s order_total=%s transaction_id=%s gateway=%s "
            "gateway_transaction_id=%s current_status_id=%s target_status_id=%s (%s)",
            order_id, order_total, transaction_id, gateway, gateway_transaction_id,
            order.get("status_id"), AWAITING_FULFILLMENT,
            "dry run" if DRY_RUN else "advancing",
        )
        if not DRY_RUN:
            advance_order(order_id)
        advanced += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for review.",
        advanced, "to advance" if DRY_RUN else "advanced", flagged,
    )


if __name__ == "__main__":
    run()
