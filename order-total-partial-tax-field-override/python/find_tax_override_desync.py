"""Find BigCommerce orders where only one side of a tax override pair was set.

The V2 Orders API (POST/PUT /v2/orders) lets integrators override computed money
fields, but each override is defined in tax-inclusive/exclusive pairs: a line
item's price_inc_tax requires price_ex_tax (and vice versa), and an order's
total_inc_tax requires total_ex_tax (and vice versa). If a client sets only one
side of a pair, BigCommerce does not reject the request or auto-derive the
missing value. It stores exactly what it was given, so the untouched field keeps
its stale or default value, often 0.00. This produces an order whose totals do
not reconcile against tax_total or the sum of its line items. Because correcting
historical tax amounts is a financial and compliance decision, this job reports
findings by default and only writes a guarded repair for orders explicitly
confirmed as not yet invoiced or shipped.

Guide: https://www.allanninal.dev/bigcommerce/order-total-partial-tax-field-override/
"""
import os
import logging
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_tax_override_desync")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
MIN_DATE_CREATED = os.environ.get("MIN_DATE_CREATED", "-30 days")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIRMED_ORDER_IDS = {
    int(x) for x in os.environ.get("CONFIRMED_ORDER_IDS", "").split(",") if x.strip()
}

EPSILON = Decimal("0.01")
REPAIRABLE_STATUS_IDS = {0, 11}  # Incomplete, Awaiting Fulfillment

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def to_decimal(value):
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _check_pair(scope, entity_id, field_a, field_b, value_a, value_b, findings):
    a = to_decimal(value_a)
    b = to_decimal(value_b)
    a_set = a is not None and a != 0
    b_set = b is not None and b != 0
    if a_set != b_set:
        findings.append({
            "scope": scope,
            "id": entity_id,
            "field_pair": (field_a, field_b),
            "value_a": a if a is not None else Decimal("0"),
            "value_b": b if b is not None else Decimal("0"),
            "reason": "partial_override",
        })


def find_tax_override_desync(order: dict, line_items: list, epsilon: Decimal = EPSILON) -> list:
    """Pure decision logic, no I/O.

    Takes an already-fetched order dict (from GET /v2/orders/{id}) and its line
    items (from GET /v2/orders/{id}/products), both with money fields as strings.
    Returns a list of finding dicts: {"scope": "order"|"line_item", "id": ...,
    "field_pair": (a, b), "value_a": Decimal, "value_b": Decimal,
    "reason": "partial_override"|"total_mismatch"}. Empty list means the order
    is internally consistent.

    Logic:
      1. For the order and for each line item, parse the ex_tax/inc_tax pair as
         Decimal.
      2. If one of the pair is zero/None and the other is non-zero -> emit a
         partial_override finding.
      3. Sum line items' total_inc_tax (+shipping_cost_inc_tax
         +handling_cost_inc_tax -discount_amount) and compare to
         order.total_inc_tax; if abs(diff) > epsilon -> emit a total_mismatch
         finding.
      4. Return all findings (empty list = consistent order).
    """
    findings = []

    _check_pair(
        "order", order.get("id"), "total_ex_tax", "total_inc_tax",
        order.get("total_ex_tax"), order.get("total_inc_tax"), findings,
    )

    for item in line_items or []:
        _check_pair(
            "line_item", item.get("id"), "price_ex_tax", "price_inc_tax",
            item.get("price_ex_tax"), item.get("price_inc_tax"), findings,
        )

    line_sum = sum(
        (to_decimal(item.get("total_inc_tax")) or Decimal("0")) for item in (line_items or [])
    )
    shipping = to_decimal(order.get("shipping_cost_inc_tax")) or Decimal("0")
    handling = to_decimal(order.get("handling_cost_inc_tax")) or Decimal("0")
    discount = to_decimal(order.get("discount_amount")) or Decimal("0")
    computed_total = line_sum + shipping + handling - discount
    order_total = to_decimal(order.get("total_inc_tax")) or Decimal("0")

    if abs(computed_total - order_total) > epsilon:
        findings.append({
            "scope": "order",
            "id": order.get("id"),
            "field_pair": ("computed_total_inc_tax", "total_inc_tax"),
            "value_a": computed_total,
            "value_b": order_total,
            "reason": "total_mismatch",
        })

    return findings


def candidate_orders():
    """Page through orders created within the configured date window."""
    page = 1
    while True:
        orders = bc_get(
            "/orders",
            {"min_date_created": MIN_DATE_CREATED, "page": page, "limit": 250},
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_line_items(order_id):
    return bc_get(f"/orders/{order_id}/products")


def repair_order(order, computed_total_ex_tax, computed_total_inc_tax):
    """Guarded repair. Only ever called for confirmed, still-open orders."""
    return bc_put(
        f"/orders/{order['id']}",
        {
            "total_ex_tax": str(computed_total_ex_tax),
            "total_inc_tax": str(computed_total_inc_tax),
        },
    )


def run():
    orders_checked = 0
    orders_with_findings = 0
    total_findings = 0

    for order in candidate_orders():
        orders_checked += 1
        order_id = order["id"]
        line_items = order_line_items(order_id)

        findings = find_tax_override_desync(order, line_items)

        if not findings:
            continue

        orders_with_findings += 1
        total_findings += len(findings)

        for finding in findings:
            log.warning(
                "scope=%s id=%s field_pair=%s value_a=%s value_b=%s reason=%s order_id=%s",
                finding["scope"], finding["id"], finding["field_pair"],
                finding["value_a"], finding["value_b"], finding["reason"], order_id,
            )

        status_id = order.get("status_id")
        if order_id in CONFIRMED_ORDER_IDS and status_id in REPAIRABLE_STATUS_IDS:
            line_sum_inc = sum(
                (to_decimal(i.get("total_inc_tax")) or Decimal("0")) for i in (line_items or [])
            )
            line_sum_ex = sum(
                (to_decimal(i.get("total_ex_tax")) or Decimal("0")) for i in (line_items or [])
            )
            shipping_inc = to_decimal(order.get("shipping_cost_inc_tax")) or Decimal("0")
            shipping_ex = to_decimal(order.get("shipping_cost_ex_tax")) or Decimal("0")
            handling_inc = to_decimal(order.get("handling_cost_inc_tax")) or Decimal("0")
            handling_ex = to_decimal(order.get("handling_cost_ex_tax")) or Decimal("0")
            discount = to_decimal(order.get("discount_amount")) or Decimal("0")

            recomputed_inc = line_sum_inc + shipping_inc + handling_inc - discount
            recomputed_ex = line_sum_ex + shipping_ex + handling_ex - discount

            log.info(
                "order_id=%s confirmed repair candidate. recomputed_total_ex_tax=%s "
                "recomputed_total_inc_tax=%s (%s)",
                order_id, recomputed_ex, recomputed_inc,
                "dry run" if DRY_RUN else "writing",
            )
            if not DRY_RUN:
                repair_order(order, recomputed_ex, recomputed_inc)

    log.info(
        "Done. %d order(s) checked, %d order(s) with findings, %d finding(s) total.",
        orders_checked, orders_with_findings, total_findings,
    )


if __name__ == "__main__":
    run()
