"""Reconcile BigCommerce coupon usage counts against real completed orders.

BigCommerce increments a coupon's num_uses on /v2/coupons the instant an
order is placed with that code applied. It never decrements it when the
order is later cancelled, declined, refunded, or manually edited or deleted,
because num_uses is documented as a read-only, system-maintained field that
cannot be corrected through a PUT or POST. The stored count drifts upward
relative to real usage until it collides with max_uses or
max_uses_per_customer and blocks a legitimate customer.

This pages GET /v2/coupons for every coupon's reported num_uses, pages
GET /v2/orders plus GET /v2/orders/{id}/coupons to find every order that ever
carried each code, keeps only the orders whose status_id represents a real
completed or in-progress sale, and reconciles the two numbers with a pure
function. It never writes to num_uses. The default action is to flag drifted
coupons to a review queue. A destructive delete-and-recreate reset is available
only behind an explicit --confirm flag, off by default. Guarded by DRY_RUN.
Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/coupon-usage-miscounts/
"""
import os
import sys
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_coupon_usage")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
MIN_DATE_CREATED = os.environ.get("MIN_DATE_CREATED")  # e.g. "2026-01-01T00:00:00"

VALID_STATUS_IDS = frozenset({2, 3, 7, 8, 9, 10, 11})
# 2 Shipped, 3 Partially Shipped, 7 Awaiting Payment, 8 Awaiting Pickup,
# 9 Awaiting Shipment, 10 Completed, 11 Awaiting Fulfillment
# Excluded: 0 Incomplete, 5 Cancelled, 6 Declined, 4 Refunded, 14 Partially Refunded,
# 1 Pending, 12 Manual Verification Required, 13 Disputed


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    if not r.content:
        return None
    return r.json()


def reconcile_coupon_usage(coupon, orders_with_coupon,
                            valid_status_ids=VALID_STATUS_IDS, tolerance=0):
    """coupon: {"id","code","num_uses","max_uses","max_uses_per_customer"}
    orders_with_coupon: [{"order_id","status_id","coupon_code"}, ...] -- every
    order found to reference this coupon code, regardless of status.
    Pure, no I/O. Decision logic only:
      true_uses = count of orders whose status_id is in valid_status_ids
      delta = coupon["num_uses"] - true_uses
      drifted = delta > tolerance
      offending_order_ids = order_ids NOT in valid_status_ids that still
        counted toward num_uses (the presumed source of inflation)
    Returns: {"coupon_id","code","reported_uses","true_uses","delta",
              "drifted","offending_order_ids"}
    """
    true_uses = sum(1 for o in orders_with_coupon if o["status_id"] in valid_status_ids)
    delta = coupon["num_uses"] - true_uses
    offending_order_ids = sorted(
        o["order_id"] for o in orders_with_coupon if o["status_id"] not in valid_status_ids
    )
    return {
        "coupon_id": coupon["id"],
        "code": coupon["code"],
        "reported_uses": coupon["num_uses"],
        "true_uses": true_uses,
        "delta": delta,
        "drifted": delta > tolerance,
        "offending_order_ids": offending_order_ids,
    }


def all_coupons():
    """Yield every coupon, paginated."""
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v2/coupons?limit={limit}&page={page}") or []
        if not batch:
            return
        for coupon in batch:
            yield coupon
        if len(batch) < limit:
            return
        page += 1


def all_orders():
    """Yield every order, paginated, optionally from MIN_DATE_CREATED forward."""
    page = 1
    limit = 250
    while True:
        qs = f"limit={limit}&page={page}"
        if MIN_DATE_CREATED:
            qs += f"&min_date_created={MIN_DATE_CREATED}"
        batch = bc("GET", f"/v2/orders?{qs}") or []
        if not batch:
            return
        for order in batch:
            yield order
        if len(batch) < limit:
            return
        page += 1


def order_coupon_codes(order_id):
    """Every coupon code applied to one order, regardless of the order's status."""
    rows = bc("GET", f"/v2/orders/{order_id}/coupons") or []
    return [row["code"] for row in rows]


def build_orders_by_code():
    """Walk every order once, and bucket {order_id, status_id} by coupon code."""
    by_code = {}
    for order in all_orders():
        codes = order_coupon_codes(order["id"])
        for code in codes:
            by_code.setdefault(code, []).append({
                "order_id": order["id"],
                "status_id": order["status_id"],
                "coupon_code": code,
            })
    return by_code


def flag_for_review(result, review_queue):
    """The only 'write' the default flow performs: append to a review queue.
    Never touches num_uses. review_queue is any append-only sink you control,
    for example a database table, a file, or an app's own metadata store."""
    review_queue.append({
        "coupon_id": result["coupon_id"],
        "code": result["code"],
        "reported_uses": result["reported_uses"],
        "true_uses": result["true_uses"],
        "delta": result["delta"],
        "offending_order_ids": result["offending_order_ids"],
    })


def reset_coupon_destructive(coupon):
    """DELETE + POST to reset num_uses to 0. Destructive: usage history is lost
    and cannot be seeded with the true count. Only called when --confirm is passed."""
    bc("DELETE", f"/v2/coupons/{coupon['id']}")
    return bc("POST", "/v2/coupons", json={
        "code": coupon["code"],
        "type": coupon["type"],
        "amount": coupon["amount"],
        "max_uses": coupon.get("max_uses"),
        "expires": coupon.get("expires"),
    })


def run(confirm_reset=False):
    orders_by_code = build_orders_by_code()
    review_queue = []
    drifted_count = 0

    for coupon in all_coupons():
        orders_with_coupon = orders_by_code.get(coupon["code"], [])
        result = reconcile_coupon_usage(coupon, orders_with_coupon)
        if not result["drifted"]:
            continue

        drifted_count += 1
        log.warning(
            "Coupon %r (id=%s) reports %s uses, true usage is %s, delta %s. Offending orders: %s. %s",
            result["code"], result["coupon_id"], result["reported_uses"],
            result["true_uses"], result["delta"], result["offending_order_ids"],
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_for_review(result, review_queue)

        if confirm_reset and not DRY_RUN:
            log.warning("Resetting coupon %r via delete and recreate. Usage history will reset to 0.", result["code"])
            reset_coupon_destructive(coupon)

    log.info("Done. %d coupon(s) drifted, %d flagged.", drifted_count, len(review_queue))
    return review_queue


if __name__ == "__main__":
    confirm = "--confirm" in sys.argv
    run(confirm_reset=confirm)
