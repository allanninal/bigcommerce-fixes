"""Detect BigCommerce orders whose coupon discount was silently recalculated away.

BigCommerce's V2 Orders API treats coupon_discount as a read-only, server-derived
value, calculated from the /v2/orders/{id}/coupons sub-resource and each line
item's applied_discounts, not stored as an independently editable field on the
order record. When a PUT to /v2/orders/{id} changes any total-affecting property,
line items, subtotal_ex_tax/subtotal_inc_tax, total_ex_tax/total_inc_tax, shipping,
handling, wrapping, or fees, BigCommerce recalculates the subtotal and total
fields from the current line items and cost fields, and per BigCommerce's own
documentation the PUT request clears all discounts and promotions applied to the
changed order line items. Because there is no writable coupon_discount field to
resend, a PUT aimed at an unrelated field can silently zero out or shrink a
previously applied coupon discount. This job diffs each modified order against a
stored known-good snapshot and the live coupons sub-resource, and reports the
orders where the discount no longer reconciles. Report only by default. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/order-update-overwrites-coupon-total/
"""
import os
import logging
from decimal import Decimal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_coupon_overwrite")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RECONCILE_TOLERANCE = Decimal("0.99")

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


def detect_coupon_overwrite(snapshot: dict, live: dict, active_coupons: list) -> dict:
    """Pure decision. No network, no side effects.

    snapshot/live = {order_id, coupon_discount, total_inc_tax, total_ex_tax, date_modified}
    active_coupons = list of {code, discount, type}

    expected_discount = sum of every active coupon's discount. If there is no
    active discount expected, or the live coupon_discount did not drop below
    the snapshot, or nothing has actually changed (same date_modified), the
    order is not corrupted. Otherwise, compare how much the total actually
    fell against how much the coupon discount alone should account for. If
    the total fell by meaningfully less than the expected discount, the
    discount was recalculated away rather than legitimately superseded by an
    unrelated line-item change, so the order is flagged as corrupted with the
    missing delta.
    """
    expected_discount = sum((c["discount"] for c in active_coupons), Decimal("0"))

    result = {
        "order_id": live["order_id"],
        "is_corrupted": False,
        "expected_discount": expected_discount,
        "observed_discount": live["coupon_discount"],
        "delta_missing": Decimal("0"),
    }

    if expected_discount <= 0:
        return result

    if live["coupon_discount"] >= snapshot["coupon_discount"]:
        return result

    if live["date_modified"] == snapshot["date_modified"]:
        return result

    delta = snapshot["total_inc_tax"] - live["total_inc_tax"]

    if delta < expected_discount * RECONCILE_TOLERANCE:
        result["is_corrupted"] = True
        result["delta_missing"] = expected_discount - (
            snapshot["coupon_discount"] - live["coupon_discount"]
        )

    return result


def modified_orders():
    """Page through orders modified within the lookback window."""
    page = 1
    while True:
        orders = bc_get(
            "/orders",
            {
                "min_date_modified": f"-{LOOKBACK_DAYS} days",
                "page": page,
                "limit": 250,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_coupons(order_id):
    return bc_get(f"/orders/{order_id}/coupons")


def load_snapshot(order_id):
    """Placeholder for your local snapshot store, keyed by order id, recorded
    at the last known-good state (e.g. right after the store/order/created
    webhook). Replace with a real database or file lookup."""
    return None


def reapply_known_good_totals(order_id, total_ex_tax, total_inc_tax):
    # Only ever called under an explicit --allow-write flag, never by default.
    return bc_put(
        f"/orders/{order_id}",
        {"total_ex_tax": str(total_ex_tax), "total_inc_tax": str(total_inc_tax)},
    )


def run(allow_write=False):
    flagged = 0
    checked = 0

    for order in modified_orders():
        order_id = order["id"]
        snapshot = load_snapshot(order_id)
        if snapshot is None:
            continue

        checked += 1
        coupons = order_coupons(order_id)
        active_coupons = [
            {"code": c.get("code"), "discount": Decimal(str(c.get("discount", "0"))), "type": c.get("type")}
            for c in coupons or []
        ]

        live = {
            "order_id": order_id,
            "coupon_discount": Decimal(str(order.get("coupon_discount", "0"))),
            "total_inc_tax": Decimal(str(order.get("total_inc_tax", "0"))),
            "total_ex_tax": Decimal(str(order.get("total_ex_tax", "0"))),
            "date_modified": order.get("date_modified"),
        }

        result = detect_coupon_overwrite(snapshot, live, active_coupons)

        if not result["is_corrupted"]:
            continue

        codes = ", ".join(c["code"] for c in active_coupons if c.get("code"))
        log.warning(
            "order_id=%s coupon overwrite detected. expected_discount=%s observed_discount=%s "
            "delta_missing=%s coupons=%s",
            order_id, result["expected_discount"], result["observed_discount"],
            result["delta_missing"], codes,
        )
        flagged += 1

        if allow_write and not DRY_RUN:
            reapply_known_good_totals(
                order_id, snapshot["total_ex_tax"], snapshot["total_inc_tax"]
            )
            confirm = bc_get(f"/orders/{order_id}")
            confirmed = Decimal(str(confirm.get("coupon_discount", "0"))) >= snapshot["coupon_discount"]
            log.info("order_id=%s reconciled=%s", order_id, confirmed)

    log.info("Done. %d order(s) checked, %d order(s) flagged for a wiped coupon discount.", checked, flagged)


if __name__ == "__main__":
    run(allow_write=os.environ.get("ALLOW_WRITE", "false").lower() == "true")
