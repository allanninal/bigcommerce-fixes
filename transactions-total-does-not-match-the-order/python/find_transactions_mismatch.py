"""Flag BigCommerce orders whose transactions do not add up to the order total.

Order totals (total_inc_tax, refunded_amount) and the gateway transaction ledger
are written through separate code paths. A gateway-side refund, a partial or
store-credit refund never posted back as a transaction, or an overridden
refund_quote amount can leave the two records disagreeing. This reads each
recent order's total and refunded_amount, sums its settled purchase, capture,
and refund transactions, and writes a RECON_MISMATCH note to staff_notes when
the two disagree by more than a cent. It never edits total_inc_tax,
refunded_amount, or status_id. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/transactions-total-does-not-match-the-order/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_transactions_mismatch")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
MIN_DATE_MODIFIED = os.environ.get("MIN_DATE_MODIFIED", "")
EPSILON_CENTS = int(os.environ.get("RECON_EPSILON_CENTS", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RECON_STATUS_IDS = {2, 3, 4, 10, 14}
CHARGE_TYPES = {"purchase", "capture"}


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def to_cents(amount):
    return round(float(amount) * 100)


def reconcile_order_transactions(order, transactions, epsilon_cents=1):
    """Pure decision function. No network or DB calls.

    order: {"totalIncTax": number|str, "refundedAmount": number|str}
    transactions: list of {"type": "purchase"|"capture"|"refund"|"void", "amount": number|str, "success": bool}

    Returns {"isMismatched": bool, "expectedNet": int, "actualNet": int, "diffCents": int}
    where the amounts are integer cents.
    """
    settled_in = sum(
        to_cents(t["amount"]) for t in transactions
        if t.get("success") and t.get("type") in CHARGE_TYPES
    )
    settled_out = sum(
        to_cents(t["amount"]) for t in transactions
        if t.get("success") and t.get("type") == "refund"
    )
    actual_net = settled_in - settled_out
    expected_net = to_cents(order["totalIncTax"]) - to_cents(order["refundedAmount"])
    diff_cents = actual_net - expected_net
    return {
        "isMismatched": abs(diff_cents) > epsilon_cents,
        "expectedNet": expected_net,
        "actualNet": actual_net,
        "diffCents": diff_cents,
    }


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
            if int(row["status_id"]) in RECON_STATUS_IDS:
                yield row
        page += 1


def order_transactions(order_id):
    rows = bc("GET", f"/v2/orders/{order_id}/transactions") or []
    return [
        {"type": row.get("type"), "amount": row.get("amount"), "success": bool(row.get("success"))}
        for row in rows
    ]


def flag_order(order_id, result):
    note = (f"RECON_MISMATCH: expected={result['expectedNet']} "
            f"actual={result['actualNet']} diff={result['diffCents']}")
    return bc("PUT", f"/v2/orders/{order_id}", json={"staff_notes": note})


def run():
    flagged = 0
    for row in orders_to_check():
        order = {"totalIncTax": row["total_inc_tax"], "refundedAmount": row["refunded_amount"]}
        transactions = order_transactions(row["id"])
        result = reconcile_order_transactions(order, transactions, EPSILON_CENTS)
        if not result["isMismatched"]:
            continue
        log.warning(
            "Order #%s mismatched. expected=%s actual=%s diff=%s. %s",
            row["id"], result["expectedNet"], result["actualNet"], result["diffCents"],
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_order(row["id"], result)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
