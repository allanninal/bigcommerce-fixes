"""Flag BigCommerce orders whose persisted tax does not match its own line detail.

BigCommerce's tax engine rounds sales tax per line item, unit price times rate,
rounding a half cent or above up to the nearest cent, then sums those independently
rounded line amounts into order.total_tax. The storefront cart or checkout can show
a subtotal-level estimate or an async tax provider figure, so what the customer saw
and what BigCommerce persisted can differ by a cent or more. This reads each order's
total_tax alongside the authoritative /taxes breakdown and the /products line detail,
sums both independently, and writes a TAX_MISMATCH note to staff_notes when they
disagree by a cent or more. It never edits total_tax or price_tax. Run on a schedule.
Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_tax_mismatch")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
TOLERANCE_CENTS = int(os.environ.get("TAX_EPSILON_CENTS", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RECON_STATUS_IDS = {0, 1, 7, 9, 11}


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


def find_tax_mismatch(order, order_taxes, order_products, tolerance_cents=1):
    """Pure decision function. No network calls.

    order: {"id": int, "total_tax": str, "status_id": int}
    order_taxes: list of {"name": str, "amount": str, "rate": str}
    order_products: list of {"price_tax": str, "quantity": int, "price_ex_tax": str}

    Returns None when both the /taxes sum and the /products price_tax sum are
    within tolerance_cents of order.total_tax. Otherwise returns a mismatch
    record naming whichever source disagrees by the larger magnitude.
    """
    sum_taxes_endpoint = sum(to_cents(t["amount"]) for t in order_taxes)
    sum_products_tax = sum(to_cents(p["price_tax"]) for p in order_products)
    actual_tax = to_cents(order["total_tax"])

    delta_a = actual_tax - sum_taxes_endpoint
    delta_b = actual_tax - sum_products_tax

    if abs(delta_a) <= tolerance_cents and abs(delta_b) <= tolerance_cents:
        return None

    if abs(delta_a) >= abs(delta_b):
        source, delta_cents, expected_cents = "taxes_endpoint", delta_a, sum_taxes_endpoint
    else:
        source, delta_cents, expected_cents = "products_sum", delta_b, sum_products_tax

    return {
        "orderId": order["id"],
        "mismatch": True,
        "deltaCents": delta_cents,
        "expectedTax": expected_cents / 100,
        "actualTax": actual_tax / 100,
        "source": source,
    }


def orders_to_check():
    page = 1
    while True:
        rows = bc("GET", f"/v2/orders?page={page}&limit=50")
        if not rows:
            return
        for row in rows:
            if int(row["status_id"]) in RECON_STATUS_IDS:
                yield row
        page += 1


def order_taxes(order_id):
    rows = bc("GET", f"/v2/orders/{order_id}/taxes") or []
    return [{"name": row.get("name"), "amount": row.get("amount"), "rate": row.get("rate")} for row in rows]


def order_products(order_id):
    rows = bc("GET", f"/v2/orders/{order_id}/products") or []
    return [
        {"price_tax": row.get("price_tax"), "quantity": row.get("quantity"), "price_ex_tax": row.get("price_ex_tax")}
        for row in rows
    ]


def flag_order(order_id, result):
    note = (f"TAX_MISMATCH: total_tax={result['actualTax']} "
            f"taxes_sum={result['expectedTax']} delta={result['deltaCents']} cents "
            f"- needs manual credit/adjustment")
    return bc("PUT", f"/v2/orders/{order_id}", json={"staff_notes": note})


def run():
    flagged = 0
    for row in orders_to_check():
        order = {"id": row["id"], "total_tax": row["total_tax"], "status_id": row["status_id"]}
        taxes = order_taxes(row["id"])
        products = order_products(row["id"])
        result = find_tax_mismatch(order, taxes, products, TOLERANCE_CENTS)
        if result is None:
            continue
        log.warning(
            "Order #%s tax mismatched via %s. total_tax=%s expected=%s delta=%s cents. %s",
            row["id"], result["source"], result["actualTax"], result["expectedTax"], result["deltaCents"],
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_order(row["id"], result)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
