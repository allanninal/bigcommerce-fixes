"""Find BigCommerce orders whose status_id implies a completed payment action,
a refund, a void, or a capture, that never actually happened at the gateway.

BigCommerce's admin Action menu (Refund, Void transaction, Capture funds) is
what calls the payment gateway; it updates status_id only as a side effect
after that call succeeds. status_id itself is a plain label with no hook back
into the gateway. Writing it directly with PUT /v2/orders/{id} changes the
label instantly but skips the gateway call entirely, so an order can read
Refunded or Cancelled with no refund or void transaction ever created. This
job lists candidate orders by status_id, reads each order's transactions, and
flags any order whose implied payment action has no matching successful
transaction to back it up. It never writes status_id and never calls a
payment action on its own; it only reports, for a human to confirm before any
remediation. Run on demand or on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/status-change-skips-payment-side-effects/
"""
import os
import logging
from typing import Optional

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_status_without_payment_action")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
CANDIDATE_STATUS_IDS = [
    int(s.strip()) for s in os.environ.get("CANDIDATE_STATUS_IDS", "4,5,10,14").split(",") if s.strip()
]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

REFUND_STATUS_IDS = {4, 14}                    # Refunded, Partially Refunded
CANCELLED_STATUS_ID = 5                        # Cancelled
CAPTURE_IMPLIED_STATUS_IDS = {2, 9, 10, 11}    # Shipped, Awaiting Shipment, Completed, Awaiting Fulfillment


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def find_status_without_payment_action(order: dict, transactions: list) -> Optional[str]:
    """Pure decision. No network, no side effects.

    order: dict with at least {'id': int, 'status_id': int, 'payment_status': str}
    transactions: list of dicts with at least {'type': str, 'status': str}

    Only transactions with status "ok" count as real side effects. An order
    is treated as authorize-only if it has an ok "auth" transaction with no
    matching ok "capture" or "purchase". Returns a violation code
    (MISSING_REFUND, MISSING_VOID, MISSING_CAPTURE) or None if the status
    and the transaction history are consistent.
    """
    ok_txns = [t for t in transactions if t.get("status") == "ok"]
    has = lambda ttype: any(t.get("type") == ttype for t in ok_txns)
    had_auth_only = has("auth") and not has("capture") and not has("purchase")

    status_id = order["status_id"]
    if status_id in REFUND_STATUS_IDS and not has("refund"):
        return "MISSING_REFUND"
    if status_id == CANCELLED_STATUS_ID and had_auth_only and not has("void"):
        return "MISSING_VOID"
    if status_id in CAPTURE_IMPLIED_STATUS_IDS and had_auth_only:
        return "MISSING_CAPTURE"
    return None


def candidate_orders():
    """Page through orders at the configured candidate status_ids."""
    page = 1
    while True:
        found_any = False
        for status_id in CANDIDATE_STATUS_IDS:
            orders = bc_get("/orders", {"status_id": status_id, "page": page, "limit": 250})
            for order in orders:
                found_any = True
                yield order
        if not found_any:
            return
        page += 1


def order_transactions(order_id):
    return bc_get(f"/orders/{order_id}/transactions")


def build_report(order, transactions, violation):
    last_transaction = transactions[-1] if transactions else None
    return {
        "order_id": order["id"],
        "status_id": order["status_id"],
        "payment_status": order.get("payment_status"),
        "missing_action": violation,
        "last_transaction": last_transaction,
    }


def apply_remediation(order_id, action):
    """Gated remediation. Never called from run(); only wire this up after a
    human has confirmed a specific order_id list from the report below.

    action is one of "capture", "void", "refund". Each maps to
    POST https://api.bigcommerce.com/stores/{store_hash}/v3/orders/{order_id}/payment_actions/{action}
    (refund additionally requires a prior refund_quotes call). Always keep
    this behind DRY_RUN so a real gateway call only fires when a human has
    approved the order.
    """
    if DRY_RUN:
        log.info("DRY_RUN: would call payment_actions/%s for order %s", action, order_id)
        return None
    raise NotImplementedError(
        "Wire this to the v3 payment_actions endpoint only after manual, per-order approval"
    )


def run():
    flagged = 0
    clean = 0

    for order in candidate_orders():
        order_id = order["id"]
        transactions = order_transactions(order_id)

        violation = find_status_without_payment_action(order, transactions)
        if violation is None:
            clean += 1
            continue

        flagged += 1
        report = build_report(order, transactions, violation)
        log.warning(
            "order_id=%s status_id=%s payment_status=%s missing_action=%s last_transaction=%s",
            report["order_id"], report["status_id"], report["payment_status"],
            report["missing_action"], report["last_transaction"],
        )

    log.info("Done. %d order(s) flagged, %d order(s) consistent.", flagged, clean)


if __name__ == "__main__":
    run()
