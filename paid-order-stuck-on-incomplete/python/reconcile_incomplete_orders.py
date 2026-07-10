"""Find BigCommerce orders stuck on Incomplete (status_id 0) that were actually paid.

BigCommerce writes an order the moment a shopper reaches the payment page, before
the gateway result is known. A second call from the gateway is supposed to flip the
order to Awaiting Fulfillment (status_id 11). When that callback is delayed, dropped,
or the gateway never notifies BigCommerce, the order is stuck on Incomplete even
though a real transaction and a capture exist on the gateway side. Incomplete orders
are excluded from the normal fulfillment queue, so these sit invisible until a
customer complains.

This job lists Incomplete orders in a lookback window, pulls each order's
transactions, and classifies it with a pure function. Confirmed paid-but-incomplete
orders are moved to Awaiting Fulfillment (status_id 11). Orders with conflicting
signals (a capture followed by a void, or a decline) are only logged for manual
review, never auto-repaired. Guarded by DRY_RUN. Safe to run again and again.
"""
import os
import logging
from typing import Literal, Optional, TypedDict

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_incomplete_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE_URL = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

INCOMPLETE_STATUS_ID = 0
AWAITING_FULFILLMENT_STATUS_ID = 11

CHARGE_TYPES = {"purchase", "capture"}
SUCCESS_STATUSES = {"success", "approved"}
CONFLICT_STATUSES = {"declined", "failed"}

Decision = Literal["no_action", "advance_to_awaiting_fulfillment", "flag_for_review"]


class Transaction(TypedDict, total=False):
    type: str
    status: str
    gateway_transaction_id: Optional[str]


def _headers():
    return {
        "X-Auth-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def decide_order_repair(status_id: int, transactions: list) -> Decision:
    """Pure decision function. No network calls.

    Only Incomplete orders (status_id == 0) are candidates. Among their purchase or
    capture transactions: if a successful one coexists with a void or a declined or
    failed one, the signals conflict and the order needs a human. If at least one
    successful purchase or capture exists with no conflict, the order can advance to
    Awaiting Fulfillment. Otherwise (no charge transactions, or only pending or
    declined ones) there is nothing to do.
    """
    if status_id != INCOMPLETE_STATUS_ID:
        return "no_action"

    charges = [t for t in transactions if t.get("type") in CHARGE_TYPES]
    if not charges:
        return "no_action"

    def is_successful(t):
        return t.get("status") in SUCCESS_STATUSES and bool(t.get("gateway_transaction_id"))

    has_success = any(is_successful(t) for t in charges)
    has_conflict = any(
        t.get("type") == "void" or t.get("status") in CONFLICT_STATUSES
        for t in transactions
    )

    if has_success and has_conflict:
        return "flag_for_review"
    if has_success:
        return "advance_to_awaiting_fulfillment"
    return "no_action"


def list_incomplete_orders():
    """Yield candidate orders with status_id 0 created within the lookback window."""
    from datetime import datetime, timedelta, timezone

    min_date_created = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).strftime(
        "%a, %d %b %Y %H:%M:%S +0000"
    )
    page = 1
    limit = 50
    while True:
        r = requests.get(
            BASE_URL + "v2/orders",
            headers=_headers(),
            params={
                "status_id": INCOMPLETE_STATUS_ID,
                "min_date_created": min_date_created,
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


def get_transactions(order_id):
    r = requests.get(
        BASE_URL + f"v2/orders/{order_id}/transactions",
        headers=_headers(),
        timeout=30,
    )
    if r.status_code == 204:
        return []
    r.raise_for_status()
    return r.json()


def advance_to_awaiting_fulfillment(order_id):
    r = requests.put(
        BASE_URL + f"v2/orders/{order_id}",
        headers=_headers(),
        json={"status_id": AWAITING_FULFILLMENT_STATUS_ID},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    advanced = 0
    flagged = 0
    for order in list_incomplete_orders():
        order_id = order["id"]
        transactions = get_transactions(order_id)
        decision = decide_order_repair(order.get("status_id", INCOMPLETE_STATUS_ID), transactions)

        if decision == "no_action":
            continue

        if decision == "flag_for_review":
            log.warning("Order %s has conflicting transaction signals. Flagged for manual review.", order_id)
            flagged += 1
            continue

        log.info(
            "Order %s is paid but Incomplete. %s",
            order_id,
            "would advance to Awaiting Fulfillment" if DRY_RUN else "advancing to Awaiting Fulfillment",
        )
        if not DRY_RUN:
            advance_to_awaiting_fulfillment(order_id)
        advanced += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for review.",
        advanced,
        "to advance" if DRY_RUN else "advanced",
        flagged,
    )


if __name__ == "__main__":
    run()
