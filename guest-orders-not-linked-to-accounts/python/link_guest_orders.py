"""Link BigCommerce guest orders to the customer account that matches the billing email.

BigCommerce checkout lets shoppers buy without registering. Every guest order
is stored with customer_id = 0 permanently, and BigCommerce never retroactively
links it, even if that same email later registers or already has an account.
Matching is name and email based only in the merchant's head, since the
storefront and Order Management UI have no automatic "same email, different
order" reconciliation. At scale this means loyalty history, reorder, and
lifetime value reporting silently miss every guest purchase whose email
happens to match a real account.

This job lists guest orders (customer_id = 0) within a lookback window, reads
each order's billing email, resolves that email against the customer table,
and reassigns customer_id only when there is exactly one confident match.
Orders with zero matches (no account exists) or more than one match
(ambiguous, e.g. after a merge) are left untouched for manual review in the
admin's "Existing customer" order-edit flow. Run on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/bigcommerce/guest-orders-not-linked-to-accounts/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("link_guest_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

GUEST_CUSTOMER_ID = 0
# Skip Incomplete (0), Cancelled (5), Declined (6). Everything else is a real order.
EXCLUDED_STATUSES = {0, 5, 6}

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


def bc_put(path, body):
    r = requests.put(f"{API_BASE_V2}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def decide_order_link(order, customer_matches):
    """Pure decision. No network, no DB calls.

    order: {id, customer_id, billing_email, status_id}
    customer_matches: [{id, email}, ...] pre-fetched matches for the order's email

    Returns {"action": "link" | "flag" | "skip", "targetCustomerId": int | None, "reason": str}
    """
    if order.get("customer_id") != GUEST_CUSTOMER_ID:
        return {"action": "skip", "targetCustomerId": None, "reason": "already linked to a customer"}

    if order.get("status_id") in EXCLUDED_STATUSES:
        return {"action": "skip", "targetCustomerId": None, "reason": "incomplete, cancelled, or declined"}

    if len(customer_matches) == 0:
        return {"action": "flag", "targetCustomerId": None, "reason": "no account matches this email"}

    if len(customer_matches) > 1:
        return {"action": "flag", "targetCustomerId": None, "reason": "multiple accounts share this email"}

    match = customer_matches[0]
    order_email = (order.get("billing_email") or "").strip().lower()
    match_email = (match.get("email") or "").strip().lower()
    if match_email != order_email:
        return {"action": "flag", "targetCustomerId": None, "reason": "email does not match exactly"}

    return {"action": "link", "targetCustomerId": match["id"], "reason": "exactly one confident email match"}


def guest_orders():
    """Page through orders whose customer_id is 0 (guest checkout) within the lookback window."""
    page = 1
    while True:
        orders = bc_get(
            API_BASE_V2,
            "/orders",
            {
                "customer_id": GUEST_CUSTOMER_ID,
                "min_date_created": f"-{LOOKBACK_DAYS} days",
                "page": page,
                "limit": 250,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_billing_email(order_id):
    order = bc_get(API_BASE_V2, f"/orders/{order_id}")
    return ((order or {}).get("billing_address") or {}).get("email", "")


def find_customer_matches(email):
    if not email:
        return []
    data = bc_get(API_BASE_V3, "/customers", {"email:in": email})
    return [{"id": c["id"], "email": c.get("email", "")} for c in (data or {}).get("data", [])]


def link_order(order_id, customer_id):
    return bc_put(f"/orders/{order_id}", {"customer_id": customer_id})


def run():
    linked = 0
    flagged = 0
    for order in guest_orders():
        order_id = order["id"]
        billing_email = order_billing_email(order_id)
        matches = find_customer_matches(billing_email)

        decision = decide_order_link(
            {
                "id": order_id,
                "customer_id": order.get("customer_id", GUEST_CUSTOMER_ID),
                "billing_email": billing_email,
                "status_id": order.get("status_id"),
            },
            matches,
        )

        if decision["action"] == "skip":
            continue

        if decision["action"] == "flag":
            log.warning(
                "order_id=%s billing_email=%s matches=%d flagged: %s",
                order_id, billing_email, len(matches), decision["reason"],
            )
            flagged += 1
            continue

        log.info(
            "order_id=%s old_customer_id=0 new_customer_id=%s matched_email=%s %s",
            order_id, decision["targetCustomerId"], billing_email,
            "would link" if DRY_RUN else "linking",
        )
        if not DRY_RUN:
            link_order(order_id, decision["targetCustomerId"])
        linked += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for manual review.",
        linked, "to link" if DRY_RUN else "linked", flagged,
    )


if __name__ == "__main__":
    run()
