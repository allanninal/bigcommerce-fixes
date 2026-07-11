"""Serialize BigCommerce refunds per order and flag orders already corrupted by a race.

BigCommerce's refund workflow is two sequential calls per order,
POST /v3/orders/{id}/payment_actions/refund_quotes to compute the refundable
amount and eligible payment methods, then POST /v3/orders/{id}/payment_actions/refund
using that quote. Refund settlement against the gateway is asynchronous, so the
order's payment_status/status_id (Refunded=4, Partially Refunded=14) updates after
the API accepts the request, not atomically with it. BigCommerce's own docs state
that processing multiple concurrent refunds on the same order is not yet supported,
because there is no per-order idempotency lock at the API layer. When two refund
requests race for the same order_id, both can read the same pre-refund quote and
both get accepted, leaving the order mismatched.

This script does two things. First, it wraps future refund calls in a per-order
lock so a second request for the same order_id queues instead of racing. Second,
it scans orders already at status_id 4 or 14 and reconciles total_refunded against
the actual sum of refund transactions, flagging any duplicate or mismatch for a
human. It never writes a compensating refund or credit automatically, because
BigCommerce has no undo-refund endpoint and a second programmatic refund on an
already-corrupted order risks a real second charge reversal.

Guide: https://www.allanninal.dev/bigcommerce/concurrent-refunds-same-order/
"""
import os
import logging
import threading
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_refund_state")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
REFUND_LOCK_TIMEOUT_SECONDS = float(os.environ.get("REFUND_LOCK_TIMEOUT_SECONDS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REFUNDED = 4
PARTIALLY_REFUNDED = 14
RECONCILE_STATUS_IDS = {REFUNDED, PARTIALLY_REFUNDED}

MISMATCH_EPSILON = Decimal("0.01")
DUPLICATE_WINDOW_SECONDS = 1.0

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


def _parse_timestamp(date_created):
    """Best-effort parse of a date_created string to a comparable float. Returns None on failure."""
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_created)
        return dt.timestamp() if dt else None
    except (TypeError, ValueError):
        return None


def find_duplicate_ids(refund_transactions):
    """Group transactions by gateway_transaction_id, or by amount plus a close
    date_created, and return the ids of any transaction that shares a group
    with another transaction (a likely double submission)."""
    duplicate_ids = []

    by_gateway_id = {}
    for txn in refund_transactions:
        gw_id = txn.get("gateway_transaction_id")
        if not gw_id:
            continue
        by_gateway_id.setdefault(gw_id, []).append(txn)
    for group in by_gateway_id.values():
        if len(group) > 1:
            duplicate_ids.extend(t["id"] for t in group)

    already_flagged = set(duplicate_ids)
    remaining = [t for t in refund_transactions if t["id"] not in already_flagged]
    for i, a in enumerate(remaining):
        a_ts = _parse_timestamp(a.get("date_created"))
        if a_ts is None:
            continue
        for b in remaining[i + 1:]:
            b_ts = _parse_timestamp(b.get("date_created"))
            if b_ts is None:
                continue
            same_amount = a["amount"] == b["amount"]
            close_in_time = abs(a_ts - b_ts) <= DUPLICATE_WINDOW_SECONDS
            if same_amount and close_in_time:
                duplicate_ids.extend([a["id"], b["id"]])

    return sorted(set(duplicate_ids))


def reconcile_refund_state(order_total_inc_tax, order_total_refunded, refund_transactions):
    """Pure decision. No network, no side effects.

    Sums refund_transactions amounts, groups them by gateway_transaction_id or
    by amount plus a close date_created to detect a duplicate submission, and
    compares order_total_refunded against the sum to detect a mismatch.
    Returns a dict with "status" one of "ok", "flag_duplicate", or
    "flag_mismatch", plus "discrepancy" and "duplicate_ids".
    order_total_inc_tax is accepted for context and future use but is not
    required to make this decision.
    """
    total_refund_amount = sum((t["amount"] for t in refund_transactions), Decimal("0"))
    discrepancy = order_total_refunded - total_refund_amount

    duplicate_ids = find_duplicate_ids(refund_transactions)
    if duplicate_ids:
        return {"status": "flag_duplicate", "discrepancy": discrepancy, "duplicate_ids": duplicate_ids}

    if abs(discrepancy) > MISMATCH_EPSILON:
        return {"status": "flag_mismatch", "discrepancy": discrepancy, "duplicate_ids": []}

    return {"status": "ok", "discrepancy": discrepancy, "duplicate_ids": []}


_order_locks = {}
_registry_lock = threading.Lock()


def lock_for_order(order_id):
    with _registry_lock:
        if order_id not in _order_locks:
            _order_locks[order_id] = threading.Lock()
        return _order_locks[order_id]


def refund_order_serialized(order_id, refund_body):
    """Acquire a per-order lock, then call refund_quotes and refund. Releases
    the lock after the response or the configured timeout, so a second
    concurrent call for the same order_id waits instead of racing."""
    lock = lock_for_order(order_id)
    acquired = lock.acquire(timeout=REFUND_LOCK_TIMEOUT_SECONDS)
    if not acquired:
        raise TimeoutError(f"order {order_id} refund already in flight")
    try:
        if DRY_RUN:
            log.info("DRY_RUN: would call refund_quotes and refund for order %s", order_id)
            return {"dry_run": True, "order_id": order_id}
        bc_post(API_BASE_V3, f"/orders/{order_id}/payment_actions/refund_quotes", {})
        return bc_post(API_BASE_V3, f"/orders/{order_id}/payment_actions/refund", refund_body)
    finally:
        lock.release()


def orders_to_reconcile():
    """Page through orders currently at status_id 4 (Refunded) or 14 (Partially Refunded)."""
    for status_id in RECONCILE_STATUS_IDS:
        page = 1
        while True:
            orders = bc_get(
                API_BASE_V2,
                "/orders",
                {"status_id": status_id, "page": page, "limit": 50},
            )
            if not orders:
                break
            for order in orders:
                yield order
            page += 1


def order_refund_transactions(order_id):
    txns = bc_get(API_BASE_V2, f"/orders/{order_id}/transactions")
    parsed = []
    for t in txns or []:
        if (t.get("type") or "").lower() != "refund":
            continue
        try:
            amount = Decimal(str(t.get("amount")))
        except (InvalidOperation, TypeError):
            continue
        parsed.append({
            "id": str(t.get("id")),
            "amount": amount,
            "gateway_transaction_id": t.get("gateway_transaction_id") or "",
            "date_created": t.get("date_created") or "",
        })
    return parsed


def run():
    checked = 0
    flagged = 0
    for order in orders_to_reconcile():
        checked += 1
        order_id = order["id"]
        try:
            total_inc_tax = Decimal(str(order.get("total_inc_tax") or "0"))
            total_refunded = Decimal(str(order.get("total_refunded") or order.get("refunded_amount") or "0"))
        except InvalidOperation:
            log.warning("order %s has an unparsable total, skipping", order_id)
            continue

        refund_transactions = order_refund_transactions(order_id)
        result = reconcile_refund_state(total_inc_tax, total_refunded, refund_transactions)

        if result["status"] == "ok":
            continue

        flagged += 1
        log.warning(
            "order_id=%s status=%s discrepancy=%s duplicate_ids=%s total_refunded=%s total_inc_tax=%s",
            order_id, result["status"], result["discrepancy"], result["duplicate_ids"],
            total_refunded, total_inc_tax,
        )

    log.info("Done. %d order(s) checked, %d order(s) flagged for manual reconciliation.", checked, flagged)


if __name__ == "__main__":
    run()
