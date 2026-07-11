"""Find BigCommerce orders whose total_tax never moved after an order-level refund.

BigCommerce refunds come in two flavors: line-item refunds, which reference a
specific product line and route through the store's tax provider to recompute
tax on the refunded quantity, and order-level or custom-amount refunds, sent
with item_type "ORDER". An order-level refund is treated as a flat, tax-exempt
custom amount against the total refundable order amount, so the Create Refund
Quote step returns total_refund_tax_amount = 0 and the refund is processed
without touching tax. The order's stored total_tax (and downstream
total_inc_tax/total_ex_tax) is never decremented for the tax portion of what
was actually refunded. Because BigCommerce exposes no supported endpoint to
directly patch total_tax after the fact, this job reports every mismatch as a
reconciliation record for a human or finance workflow, and only re-issues a
corrective line-item refund under an explicit non dry run flag.

Guide: https://www.allanninal.dev/bigcommerce/order-refund-does-not-recalc-tax/
"""
import os
import logging
from decimal import Decimal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_refund_tax")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MIN_DATE_MODIFIED = os.environ.get("MIN_DATE_MODIFIED", "-30 days")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REFUNDED = 4
PARTIALLY_REFUNDED = 14
TOLERANCE = Decimal("0.01")

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
    return r.json()


def reconcile_order_tax(order: dict, refund_transactions: list, tolerance: float = 0.01) -> dict:
    """Pure decision logic, no I/O, no side effects.

    order: {"id": int, "total_tax": str, "total_ex_tax": str, "total_inc_tax": str}
    refund_transactions: [{"id": int, "type": "refund", "item_type": "ORDER"|"PRODUCT",
                            "amount": str, "tax_amount": str|None}]
    Returns {"order_id": int, "expected_total_tax": Decimal, "stored_total_tax": Decimal,
             "delta": Decimal, "flagged": bool, "reason": str|None}

    Decision logic:
      1. original_tax = stored total_tax + sum(tax_amount for every refund transaction)
      2. expected_total_tax = original_tax - sum(tax_amount for refund-type transactions only)
      3. order_level_refund_without_tax = any refund transaction with item_type "ORDER",
         a positive amount, and a zero (or missing) tax_amount. That is the exact
         signature of an order-level refund that skipped tax recalculation.
      4. delta = abs(expected_total_tax - stored_total_tax)
      5. flagged = delta > tolerance or order_level_refund_without_tax
      6. reason = "order-level refund skipped tax recalculation" when that signature is
         present, otherwise "total_tax drift" when flagged, otherwise None.
    """
    stored_total_tax = Decimal(order["total_tax"])

    refund_tax_sum = sum(
        Decimal(t.get("tax_amount") or "0") for t in refund_transactions
    )
    original_tax = stored_total_tax + refund_tax_sum

    refund_only_tax_sum = sum(
        Decimal(t.get("tax_amount") or "0")
        for t in refund_transactions
        if t.get("type") == "refund"
    )
    expected_total_tax = original_tax - refund_only_tax_sum

    order_level_refund_without_tax = any(
        t.get("item_type") == "ORDER"
        and Decimal(t.get("amount", "0")) > 0
        and Decimal(t.get("tax_amount") or "0") == 0
        for t in refund_transactions
    )

    delta = abs(expected_total_tax - stored_total_tax)
    flagged = delta > Decimal(str(tolerance)) or order_level_refund_without_tax

    reason = None
    if order_level_refund_without_tax:
        reason = "order-level refund skipped tax recalculation"
    elif flagged:
        reason = "total_tax drift"

    return {
        "order_id": order["id"],
        "expected_total_tax": expected_total_tax,
        "stored_total_tax": stored_total_tax,
        "delta": delta,
        "flagged": flagged,
        "reason": reason,
    }


def candidate_orders():
    """Page through Refunded (4) and Partially Refunded (14) orders in the window."""
    page = 1
    while True:
        orders = bc_get(
            API_BASE_V2,
            "/orders",
            {
                "status_id": f"{REFUNDED},{PARTIALLY_REFUNDED}",
                "min_date_modified": MIN_DATE_MODIFIED,
                "page": page,
                "limit": 250,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_refund_transactions(order_id):
    transactions = bc_get(API_BASE_V2, f"/orders/{order_id}/transactions")
    return [t for t in transactions if (t.get("type") or "").lower() == "refund"]


def quote_expected_refund_tax(order_id, refund_items_or_amount):
    """DRY_RUN refund quote, used only to learn the correct tax figure."""
    body = {**refund_items_or_amount, "dry_run": True}
    return bc_post(API_BASE_V3, f"/orders/{order_id}/payment_actions/refund_quotes", body)


def issue_corrective_refund(order_id, shortfall_amount):
    """Guarded repair. Only ever called under an explicit non dry run flag."""
    body = {"reason": "tax reconciliation shortfall", "amount": str(shortfall_amount)}
    return bc_post(API_BASE_V3, f"/orders/{order_id}/payment_actions/refunds", body)


def run():
    orders_checked = 0
    orders_flagged = 0

    for order in candidate_orders():
        orders_checked += 1
        order_id = order["id"]
        refund_transactions = order_refund_transactions(order_id)

        if not refund_transactions:
            continue

        record = reconcile_order_tax(order, refund_transactions, float(TOLERANCE))

        if not record["flagged"]:
            continue

        orders_flagged += 1
        refund_txn_id = refund_transactions[0].get("id") if refund_transactions else None

        log.warning(
            "order_id=%s stored_total_tax=%s expected_total_tax=%s delta=%s "
            "reason=%s refund_transaction_id=%s",
            record["order_id"], record["stored_total_tax"], record["expected_total_tax"],
            record["delta"], record["reason"], refund_txn_id,
        )

        if not DRY_RUN and order.get("refunded_amount") is not None:
            log.info(
                "order_id=%s issuing corrective line-item refund for shortfall=%s",
                order_id, record["delta"],
            )
            issue_corrective_refund(order_id, record["delta"])

    log.info(
        "Done. %d order(s) checked, %d order(s) flagged for tax reconciliation.",
        orders_checked, orders_flagged,
    )


if __name__ == "__main__":
    run()
