"""Flag BigCommerce orders where presentment and settlement currency diverge.

When Multi-Currency is enabled, a shopper can pay in a transactional currency
(default_currency_code) that differs from the store's base currency
(store_default_currency_code). BigCommerce records the rate between the two as
store_default_to_transactional_exchange_rate, but a finance export that reads
only the face-value total, or a gateway that settles to the bank in a third
currency at its own rate, can leave the presentment amount, the order total,
and the settlement amount all disagreeing. This reads each financially final
order's currency fields, computes the expected base-currency amount, compares
it against your ledger's recorded amount for that order, and writes an
FX_VARIANCE note to staff_notes when they disagree by more than a tolerance.
It never edits total_inc_tax, default_currency_code, or the exchange rate.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/presentment-vs-settlement-currency/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_currency_variance")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
MIN_DATE_CREATED = os.environ.get("MIN_DATE_CREATED", "")
TOLERANCE_RATIO = float(os.environ.get("FX_TOLERANCE_RATIO", "0.005"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Financially final BigCommerce order statuses: Completed, Awaiting
# Fulfillment, Shipped, Partially Shipped, Partially Refunded.
FINAL_STATUS_IDS = {10, 11, 2, 3, 14}


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def classify_currency_variance(order, tolerance_ratio=0.005):
    """Pure decision function. No network calls.

    order: {
        "defaultCurrencyCode": str, "storeDefaultCurrencyCode": str,
        "totalIncTax": number|str, "storeDefaultToTransactionalExchangeRate": number|str,
        "ledgerBaseAmount": number|str,
    }

    Returns whether the order's presentment currency differs from the store's
    base currency AND the expected base-currency amount (total_inc_tax times
    the store_default_to_transactional_exchange_rate) diverges from the
    ledger's recorded base amount by more than tolerance_ratio.
    """
    default_ccy = order["defaultCurrencyCode"]
    store_ccy = order["storeDefaultCurrencyCode"]
    rate = float(order["storeDefaultToTransactionalExchangeRate"])
    total = float(order["totalIncTax"])
    ledger_base_amount = float(order["ledgerBaseAmount"])

    is_mismatch = default_ccy != store_ccy
    expected_base_amount = total * rate if is_mismatch else total
    variance = abs(expected_base_amount - ledger_base_amount)
    variance_ratio = (variance / expected_base_amount) if expected_base_amount else 0.0

    return {
        "isMismatch": is_mismatch and variance_ratio > tolerance_ratio,
        "presentmentCurrency": default_ccy,
        "settlementCurrency": store_ccy,
        "expectedBaseAmount": expected_base_amount,
        "variance": variance,
        "varianceRatio": variance_ratio,
    }


def orders_to_check():
    page = 1
    while True:
        params = f"page={page}&limit=50"
        if MIN_DATE_CREATED:
            params += f"&min_date_created={MIN_DATE_CREATED}"
        rows = bc("GET", f"/v2/orders?{params}")
        if not rows:
            return
        for row in rows:
            if int(row["status_id"]) in FINAL_STATUS_IDS:
                yield row
        page += 1


def order_transactions(order_id):
    return bc("GET", f"/v2/orders/{order_id}/transactions") or []


def ledger_base_amount_for(order_id, transactions):
    """Placeholder for your own ledger lookup.

    Wire this to your accounting export or payout report keyed by order_id.
    Falls back to summing settled gateway transaction amounts when no
    external ledger is configured.
    """
    return sum(float(t["amount"]) for t in transactions if t.get("success"))


def flag_order(order_id, result):
    note = (
        f"FX_VARIANCE: presentment={result['presentmentCurrency']} "
        f"settlement={result['settlementCurrency']} "
        f"expected={result['expectedBaseAmount']:.2f} "
        f"variance={result['variance']:.2f} "
        f"ratio={result['varianceRatio']:.4f}"
    )
    return bc("PUT", f"/v2/orders/{order_id}", json={"staff_notes": note})


def run():
    flagged = 0
    for row in orders_to_check():
        transactions = order_transactions(row["id"])
        order = {
            "defaultCurrencyCode": row.get("default_currency_code") or row.get("currency_code"),
            "storeDefaultCurrencyCode": row.get("store_default_currency_code") or row.get("currency_code"),
            "totalIncTax": row["total_inc_tax"],
            "storeDefaultToTransactionalExchangeRate": row.get("store_default_to_transactional_exchange_rate", 1),
            "ledgerBaseAmount": ledger_base_amount_for(row["id"], transactions),
        }
        result = classify_currency_variance(order, TOLERANCE_RATIO)
        if not result["isMismatch"]:
            continue
        log.warning(
            "Order #%s currency variance. presentment=%s settlement=%s expected=%.2f variance=%.2f ratio=%.4f. %s",
            row["id"], result["presentmentCurrency"], result["settlementCurrency"],
            result["expectedBaseAmount"], result["variance"], result["varianceRatio"],
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_order(row["id"], result)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
