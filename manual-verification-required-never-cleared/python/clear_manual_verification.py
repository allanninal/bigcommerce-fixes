"""Surface and clear BigCommerce orders stuck on Manual Verification Required.

A fraud-screening app (FraudLabs Pro, NoFraud, Signifyd, Kount) or an ERP
connector writes status_id 12 to an order when it flags a REVIEW verdict.
The human review then happens inside that app's own dashboard, so nothing
tells BigCommerce the order was approved. This never auto-transitions an
order on elapsed time. It only reports orders that already carry an explicit
human-approval marker in staff_notes or messages, with a non-declined
transaction, and only writes when DRY_RUN=false. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/manual-verification-required-never-cleared/
"""
import os
import re
import logging
import requests
from datetime import datetime
from email.utils import parsedate_to_datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_manual_verification")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
MIN_DATE_MODIFIED = os.environ.get("MIN_DATE_MODIFIED")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

MANUAL_VERIFICATION_STATUS_ID = 12
AWAITING_FULFILLMENT_STATUS_ID = 11

APPROVAL_RE = re.compile(r"\b(approved|cleared|verified)\b", re.IGNORECASE)
DECLINED_TXN_STATUSES = {"declined", "void"}
OK_TXN_STATUSES = {None, "approved", "captured"}


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def _parse_date(value):
    """Best-effort parse of an ISO-8601 or RFC-2822 timestamp. Returns None on failure."""
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None


def decide_clearable(order, messages, transaction_status):
    """Pure decision logic, no I/O. Returns 'clear', 'hold', or 'skip'.

    - 'skip': the order is not on status_id 12, nothing to do here.
    - 'hold': still needs a human, or the transaction looks unsafe to clear.
    - 'clear': an explicit human-approval marker was found in staff_notes or a
      message timestamped after date_modified, and the transaction is not
      declined or voided.
    """
    if order.get("status_id") != MANUAL_VERIFICATION_STATUS_ID:
        return "skip"
    if transaction_status in DECLINED_TXN_STATUSES:
        return "hold"

    modified_at = _parse_date(order.get("date_modified"))
    has_marker = False

    note = order.get("staff_notes") or ""
    if APPROVAL_RE.search(note):
        has_marker = True

    if not has_marker:
        for msg in messages or []:
            text = msg.get("message") or ""
            if not APPROVAL_RE.search(text):
                continue
            created_at = _parse_date(msg.get("date_created"))
            if modified_at is None or created_at is None or created_at >= modified_at:
                has_marker = True
                break

    if has_marker and transaction_status in OK_TXN_STATUSES:
        return "clear"
    return "hold"


def orders_pending_verification():
    """Yield every order currently on status_id 12, paginating with page/limit."""
    page = 1
    while True:
        params = {"status_id": MANUAL_VERIFICATION_STATUS_ID, "limit": 250, "page": page}
        if MIN_DATE_MODIFIED:
            params["min_date_modified"] = MIN_DATE_MODIFIED
        batch = bc("GET", "/v2/orders", params=params) or []
        if not batch:
            return
        for order in batch:
            yield order
        if len(batch) < 250:
            return
        page += 1


def order_messages(order_id):
    return bc("GET", f"/v2/orders/{order_id}/messages") or []


def transaction_status_for(order_id):
    """Reduce an order's transactions to a single status string, or None.

    A declined or voided transaction always wins so it can never be masked by
    an approval marker. Otherwise prefer an approved/captured transaction.
    """
    txns = bc("GET", f"/v2/orders/{order_id}/transactions") or []
    for t in txns:
        status = (t.get("status") or "").lower()
        if status in DECLINED_TXN_STATUSES:
            return status
    for t in txns:
        status = (t.get("status") or "").lower()
        if status in {"approved", "captured"}:
            return status
    return None


def clear_order(order_id):
    """Move the order to Awaiting Fulfillment and leave an audit message."""
    bc("PUT", f"/v2/orders/{order_id}", json={"status_id": AWAITING_FULFILLMENT_STATUS_ID})
    bc("POST", f"/v2/orders/{order_id}/messages", json={
        "message": "Cleared Manual Verification Required to Awaiting Fulfillment "
                   "after finding an explicit staff approval marker and a non-declined transaction.",
        "status_id": AWAITING_FULFILLMENT_STATUS_ID,
    })


def run():
    cleared = 0
    held = 0
    for order in orders_pending_verification():
        order_id = order["id"]
        full_order = bc("GET", f"/v2/orders/{order_id}") or order
        messages = order_messages(order_id)
        txn_status = transaction_status_for(order_id)

        decision = decide_clearable(full_order, messages, txn_status)
        if decision == "skip":
            continue
        if decision == "hold":
            held += 1
            continue

        log.info("Order %s clearable. %s", order_id, "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_order(order_id)
        cleared += 1

    log.info("Done. %d order(s) %s, %d held for review.",
              cleared, "to clear" if DRY_RUN else "cleared", held)


if __name__ == "__main__":
    run()
