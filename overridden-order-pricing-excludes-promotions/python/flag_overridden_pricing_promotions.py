"""Flag BigCommerce orders where a manually overridden line-item price
silently excluded the order from an active, matching automatic promotion.

BigCommerce's pricing engine only evaluates promotions against catalog or
price-list-derived prices computed by its own pricing service. When a line
item is created with an explicit price_ex_tax or price_inc_tax override,
through the V2 Orders API's server-to-server order creation or the
Cart/Checkout Server-to-Server APIs, that price is a manually set custom
price, not a catalog price. By default, automatic and coupon promotions
skip line items with custom pricing. A store-level setting, "Allow
promotions to apply on products with custom price overrides" under
Settings, Promotions and coupons, has to be turned on before the promotion
engine will consider those line items. Leave it off, the default, and any
order built through a price-override integration silently gets $0 promo
discount even when an active, matching automatic promotion exists.

This is not safely auto-fixable as a write against a settled order, so the
default action is flag and report. A JSON/CSV report of
{order_id, expected_promo_ids, override_amount, recommended_action} is
produced for every match. Orders in shipped, partially shipped, refunded,
completed, or partially refunded status (status_id 2, 3, 4, 10, 14) are
always report-only. Orders at Incomplete or Awaiting Payment (status_id 0
or 7) are eligible for a guarded, opt-in repair, but this script only
recommends it, it never PUTs a recomputed discount_amount directly onto an
order, because that risks double-charging refunds and taxes.

Guide: https://www.allanninal.dev/bigcommerce/overridden-order-pricing-excludes-promotions/
"""
import csv
import json
import logging
import os

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_overridden_pricing_promotions")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
V2_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
V3_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPORT_PATH = os.environ.get("REPORT_PATH", "promo_override_report.json")

# Shipped, Partially Shipped, Refunded, Completed, Partially Refunded.
# Always report-only, never rewritten.
ALWAYS_SKIP_STATUS_IDS = {2, 3, 4, 10, 14}
# Incomplete, Awaiting Payment. Eligible for a guarded, opt-in repair.
PRE_CAPTURE_STATUS_IDS = {0, 7}

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


def flag_missing_promotion(order: dict, line_items: list, order_coupons: list, active_promotions: list):
    """Pure decision logic (no I/O) -- inputs are plain dicts/lists already
    fetched from GET /v2/orders/{id}, GET /v2/orders/{id}/products,
    GET /v2/orders/{id}/coupons, and GET /v3/promotions?status=ENABLED.

    order: {"id", "discount_amount", "coupon_discount", "subtotal_ex_tax",
            "base_total_ex_tax", "customer_group_id", "date_created"}
    line_items: [{"product_id", "price_ex_tax", "base_price", "applied_discounts": [...]}]
    order_coupons: [] or [{"code", "amount", "type"}]
    active_promotions: [{"id", "redemption_type", "rules": [...], "current_days_and_times": {...}}]

    Returns None if no discrepancy, else a flag dict:
      {"order_id", "reason", "has_price_override", "expected_promo_ids"}
    """
    has_price_override = any(
        li.get("price_ex_tax") is not None and li.get("base_price") is not None
        and li["price_ex_tax"] != li["base_price"]
        for li in line_items
    )
    no_discount_recorded = (
        float(order.get("discount_amount", "0") or 0) == 0
        and float(order.get("coupon_discount", "0") or 0) == 0
        and not order_coupons
        and not any(li.get("applied_discounts") for li in line_items)
    )
    if not (has_price_override and no_discount_recorded):
        return None

    eligible_promo_ids = [
        p["id"] for p in active_promotions
        if p.get("redemption_type") == "AUTOMATIC"
    ]
    if not eligible_promo_ids:
        return None

    return {
        "order_id": order["id"],
        "reason": "price_override_excluded_from_active_automatic_promotion",
        "has_price_override": has_price_override,
        "expected_promo_ids": eligible_promo_ids,
    }


def recommended_action(order_status_id):
    if order_status_id in ALWAYS_SKIP_STATUS_IDS:
        return "flag_only_settled_order"
    if order_status_id in PRE_CAPTURE_STATUS_IDS:
        return "flag_or_guarded_repair_pre_capture"
    return "flag_only"


def override_amount(order, line_items):
    total = 0.0
    for li in line_items:
        price_override = li.get("price_ex_tax")
        base_price = li.get("base_price")
        if price_override is not None and base_price is not None and price_override != base_price:
            try:
                total += abs(float(price_override) - float(base_price))
            except (TypeError, ValueError):
                continue
    return round(total, 2)


def candidate_orders():
    """Page through recent orders within the lookback window."""
    page = 1
    while True:
        orders = bc_get(
            V2_BASE,
            "/orders",
            {"min_date_created": f"-{LOOKBACK_DAYS} days", "page": page, "limit": 50},
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_line_items(order_id):
    return bc_get(V2_BASE, f"/orders/{order_id}/products")


def order_coupons(order_id):
    return bc_get(V2_BASE, f"/orders/{order_id}/coupons")


def active_automatic_promotions():
    resp = bc_get(V3_BASE, "/promotions", {"status": "ENABLED"})
    return resp.get("data", []) if isinstance(resp, dict) else resp


def write_report(rows, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    if path.endswith(".json"):
        csv_path = path[: -len(".json")] + ".csv"
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f, fieldnames=["order_id", "expected_promo_ids", "override_amount", "recommended_action"]
            )
            writer.writeheader()
            for row in rows:
                writer.writerow({**row, "expected_promo_ids": ";".join(str(p) for p in row["expected_promo_ids"])})


def run():
    active_promotions = active_automatic_promotions()
    report_rows = []

    for order in candidate_orders():
        order_id = order["id"]
        line_items = order_line_items(order_id)
        coupons = order_coupons(order_id)

        flag = flag_missing_promotion(order, line_items, coupons, active_promotions)
        if not flag:
            continue

        status_id = order.get("status_id")
        action = recommended_action(status_id)
        row = {
            "order_id": order_id,
            "expected_promo_ids": flag["expected_promo_ids"],
            "override_amount": override_amount(order, line_items),
            "recommended_action": action,
        }
        report_rows.append(row)
        log.warning(
            "order_id=%s status_id=%s override_amount=%s expected_promo_ids=%s action=%s (%s)",
            order_id, status_id, row["override_amount"], flag["expected_promo_ids"], action,
            "dry run, report only" if DRY_RUN else "reported, no write performed",
        )

    write_report(report_rows, REPORT_PATH)
    log.info("Done. %d order(s) flagged. Report written to %s", len(report_rows), REPORT_PATH)


if __name__ == "__main__":
    run()
