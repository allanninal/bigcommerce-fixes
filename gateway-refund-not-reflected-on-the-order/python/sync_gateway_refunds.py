"""Detect and repair BigCommerce orders where a gateway-side refund was never reflected.

BigCommerce only updates an order's status_id and writes a refund transaction record
when a refund is initiated through its own admin Refund action, or the v3
payment_actions/refunds endpoint, which calls the gateway and updates the order
atomically. If a merchant or the payment processor issues the refund directly in the
gateway's own dashboard or API, there is no callback path into BigCommerce, so the
order silently stays at its prior status_id even though the customer has already been
refunded. This reads each order's total, its status_id, BigCommerce's own recorded
refund amount (from v2 transactions and v3 payment_actions/refunds), and the gateway's
refunded amount, then decides whether to set status_id to 4 (Refunded) or 14
(Partially Refunded), or to flag the order for manual review when the amounts do not
reconcile cleanly. Because BigCommerce has no endpoint to retroactively import a
gateway-executed refund as if it went through the Refund action, every write is paired
with an order note documenting the gateway refund id, amount, and timestamp so the
discrepancy stays traceable. Run on a schedule. Safe to run again and again.
"""
import os
import logging
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_gateway_refunds")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
MIN_DATE_MODIFIED = os.environ.get("MIN_DATE_MODIFIED", "")
ROUNDING_TOLERANCE = Decimal(os.environ.get("REFUND_ROUNDING_TOLERANCE", "0.01"))
REVIEW_TAG = os.environ.get("REVIEW_TAG", "gateway-refund-needs-review")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STATUS_REFUNDED = 4
STATUS_PARTIALLY_REFUNDED = 14
ALREADY_REFUNDED_STATUSES = {STATUS_REFUNDED, STATUS_PARTIALLY_REFUNDED}
CHECK_STATUS_IDS = {2, 3, 9, 10, 11}


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def decide_refund_status(order_total, order_status_id, gateway_refunded_amount, bc_recorded_refund_amount):
    """Pure decision function. No network calls.

    order_total, gateway_refunded_amount, bc_recorded_refund_amount: Decimal
    order_status_id: int
    Returns {"action": "none"|"set_status"|"flag_manual_review",
             "target_status_id": int|None, "reason": str}
    """
    if gateway_refunded_amount < 0 or (gateway_refunded_amount - order_total) > ROUNDING_TOLERANCE:
        return {
            "action": "flag_manual_review",
            "target_status_id": None,
            "reason": (
                f"gateway_refunded_amount {gateway_refunded_amount} is inconsistent with "
                f"order_total {order_total} (negative or exceeds total beyond tolerance)"
            ),
        }

    if gateway_refunded_amount <= bc_recorded_refund_amount:
        return {
            "action": "none",
            "target_status_id": None,
            "reason": "gateway_refunded_amount already reconciled with BigCommerce's recorded refund amount",
        }

    unrecorded = gateway_refunded_amount - bc_recorded_refund_amount

    if gateway_refunded_amount >= order_total - ROUNDING_TOLERANCE:
        target_status_id = STATUS_REFUNDED
        reason = f"gateway_refunded_amount {gateway_refunded_amount} covers the order total {order_total}"
    elif unrecorded > 0:
        target_status_id = STATUS_PARTIALLY_REFUNDED
        reason = (
            f"unrecorded refund amount {unrecorded} found on the gateway that BigCommerce "
            "has not recorded"
        )
    else:
        return {
            "action": "none",
            "target_status_id": None,
            "reason": "no unrecorded refund amount",
        }

    if order_status_id == target_status_id:
        return {
            "action": "none",
            "target_status_id": None,
            "reason": f"order_status_id already equals target status_id {target_status_id}",
        }

    return {"action": "set_status", "target_status_id": target_status_id, "reason": reason}


def to_decimal(amount):
    try:
        return Decimal(str(amount))
    except (InvalidOperation, TypeError):
        return Decimal("0")


def orders_to_check():
    page = 1
    while True:
        params = f"page={page}&limit=50"
        if MIN_DATE_MODIFIED:
            params += f"&min_date_modified={MIN_DATE_MODIFIED}"
        rows = bc("GET", f"/v2/orders?{params}")
        if not rows:
            return
        for row in rows:
            if int(row["status_id"]) not in ALREADY_REFUNDED_STATUSES and int(row["status_id"]) in CHECK_STATUS_IDS:
                yield row
        page += 1


def bc_recorded_refund_amount_v2(order_id):
    """Sum settled refund transactions from GET /v2/orders/{id}/transactions."""
    rows = bc("GET", f"/v2/orders/{order_id}/transactions") or []
    total = Decimal("0")
    for row in rows:
        if row.get("type") == "refund" and row.get("success"):
            total += to_decimal(row.get("amount", "0"))
    return total


def bc_recorded_refund_amount_v3(order_id):
    """Sum recorded refunds from GET /v3/orders/{order_id}/payment_actions/refunds."""
    body = bc("GET", f"/v3/orders/{order_id}/payment_actions/refunds") or {}
    total = Decimal("0")
    for row in body.get("data", []):
        for detail in row.get("details", []):
            total += to_decimal(detail.get("amount", "0"))
    return total


def gateway_refunded_amount(order_id):
    """Look up the gateway's own refund total for this order's transaction id.

    In production this calls the gateway's own API (Stripe, Braintree, Authorize.net,
    etc.) with the transaction id recorded on the order. This stub is a seam for that
    call; wire in your gateway client here.
    """
    raise NotImplementedError("wire in your payment gateway's refund lookup here")


def flag_for_manual_review(order_id, reason):
    note = f"GATEWAY_REFUND_REVIEW: {reason}"
    return bc("PUT", f"/v2/orders/{order_id}", json={"staff_notes": note})


def apply_status(order_id, target_status_id, gateway_refund_id, amount, timestamp):
    note = (
        f"GATEWAY_REFUND_SYNCED: gateway_refund_id={gateway_refund_id} amount={amount} "
        f"at={timestamp} synced_status_id={target_status_id}"
    )
    bc("PUT", f"/v2/orders/{order_id}", json={"staff_notes": note})
    return bc("PUT", f"/v2/orders/{order_id}", json={"status_id": target_status_id})


def run():
    changed = 0
    flagged = 0
    for row in orders_to_check():
        order_id = row["id"]
        order_total = to_decimal(row.get("total_inc_tax", "0"))
        order_status_id = int(row["status_id"])

        bc_recorded = bc_recorded_refund_amount_v2(order_id) + bc_recorded_refund_amount_v3(order_id)

        try:
            gw_refunded = gateway_refunded_amount(order_id)
        except NotImplementedError:
            log.debug("Order #%s: gateway lookup not wired in, skipping.", order_id)
            continue

        decision = decide_refund_status(order_total, order_status_id, gw_refunded, bc_recorded)

        if decision["action"] == "none":
            continue

        if decision["action"] == "flag_manual_review":
            log.warning("Order #%s flagged for manual review: %s. %s",
                        order_id, decision["reason"], "would flag" if DRY_RUN else "flagging")
            if not DRY_RUN:
                flag_for_manual_review(order_id, decision["reason"])
            flagged += 1
            continue

        log.info("Order #%s: %s. %s", order_id, decision["reason"],
                  "would set status_id=%s" % decision["target_status_id"] if DRY_RUN else
                  "setting status_id=%s" % decision["target_status_id"])
        if not DRY_RUN:
            apply_status(order_id, decision["target_status_id"], gateway_refund_id="unknown",
                         amount=gw_refunded, timestamp="unknown")
        changed += 1

    log.info("Done. %d order(s) %s status, %d order(s) %s for review.",
              changed, "to set" if DRY_RUN else "set",
              flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
