"""Find BigCommerce orders that look like staff test checkouts counted as revenue.

BigCommerce order objects, in both /v2/orders and V3, have no is_test flag. Every
store ships with a Test Payment Gateway enabled by default so staff can validate
tax, shipping, and promotion configuration by placing real checkouts, and merchants
often leave real gateways in sandbox mode during setup too. Those checkouts create
fully formed orders with normal, revenue-counted status_id values, and Store Overview
and Sales reports simply aggregate by status_id, so the test order counts as revenue.

This job lists revenue-counted orders in a reporting window, pulls each order's
transactions, and classifies it with a pure function against four signals: a test
transaction flag, a Test Payment Gateway name, a test-looking billing email, and a
nominal guest checkout total. Anything that classifies as a test order gets a
non-destructive marker appended to the internal staff_notes field. Nothing is ever
cancelled or deleted automatically. Guarded by DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/test-orders-counted-in-sales-reports/
"""
import os
import re
import logging
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_test_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE_URL = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

NON_REVENUE_STATUS_IDS = {0, 5, 6}  # Incomplete, Cancelled, Declined

TEST_EMAIL_PATTERNS = [
    re.compile(r"test@", re.IGNORECASE),
    re.compile(r"@example\.com$", re.IGNORECASE),
    re.compile(r"^qa[-_.]?", re.IGNORECASE),
]


def _headers():
    return {
        "X-Auth-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def classify_test_order(order, transactions, test_email_patterns=None):
    """Pure decision function. No network calls.

    Flags an order as a likely test order when any independent signal points to a
    staff or QA checkout: a transaction marked test true, a transaction whose gateway
    name matches Test Payment Gateway, a billing email matching a known test pattern,
    or a guest checkout with a nominal total of one dollar or less. A non-revenue
    status_id (Incomplete, Cancelled, Declined) is recorded as a reason for visibility
    but never on its own marks the order as a test, since reports already exclude it.
    """
    patterns = test_email_patterns if test_email_patterns is not None else TEST_EMAIL_PATTERNS
    reasons = []

    if any(t.get("test") is True for t in transactions):
        reasons.append("test_gateway_transaction")

    if any(re.search(r"test payment gateway", t.get("gateway") or "", re.IGNORECASE) for t in transactions):
        reasons.append("test_gateway_name")

    email = (order.get("billing_address") or {}).get("email") or ""
    if any(rx.search(email) for rx in patterns):
        reasons.append("test_email_pattern")

    if order.get("customer_id") == 0 and float(order.get("total_inc_tax", 0) or 0) <= 1.00:
        reasons.append("nominal_staff_test_amount")

    if order.get("status_id") in NON_REVENUE_STATUS_IDS:
        reasons.append("non_revenue_status")

    is_test = len(reasons) > 0 and any(r != "non_revenue_status" for r in reasons)
    return {"isTest": is_test, "reasons": reasons}


def list_revenue_orders():
    """Yield candidate orders created within the lookback window, skipping the
    status_ids that reports already exclude (Incomplete, Cancelled, Declined)."""
    min_date_created = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).strftime(
        "%a, %d %b %Y %H:%M:%S +0000"
    )
    page = 1
    limit = 50
    while True:
        r = requests.get(
            BASE_URL + "v2/orders",
            headers=_headers(),
            params={"min_date_created": min_date_created, "limit": limit, "page": page},
            timeout=30,
        )
        if r.status_code == 204:
            return
        r.raise_for_status()
        orders = r.json()
        if not orders:
            return
        for order in orders:
            if order.get("status_id") not in NON_REVENUE_STATUS_IDS:
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


def flag_as_test_order(order, reasons):
    marker = f"[TEST ORDER: {', '.join(reasons)}] "
    existing_notes = order.get("staff_notes") or ""
    if existing_notes.startswith("[TEST ORDER:"):
        return None  # already flagged, do not stack markers
    r = requests.put(
        BASE_URL + f"v2/orders/{order['id']}",
        headers=_headers(),
        json={"staff_notes": marker + existing_notes},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    for order in list_revenue_orders():
        order_id = order["id"]
        transactions = get_transactions(order_id)
        result = classify_test_order(order, transactions)

        if not result["isTest"]:
            continue

        existing_notes = order.get("staff_notes") or ""
        if existing_notes.startswith("[TEST ORDER:"):
            continue

        log.info(
            "Order %s looks like a test order (%s). %s",
            order_id,
            ", ".join(result["reasons"]),
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_as_test_order(order, result["reasons"])
        flagged += 1

    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
