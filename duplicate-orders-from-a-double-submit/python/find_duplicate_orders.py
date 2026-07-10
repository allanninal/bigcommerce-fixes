"""Find and cancel duplicate BigCommerce orders created by a double submit.

A slow payment gateway or an impatient double click on Place Order can turn one
checkout into two separate orders: same customer, same products, same total,
created seconds apart. This lists recent pre-fulfillment orders, groups them
with a pure function, keeps the earliest order in each group, and cancels the
rest, but only after re-checking that the duplicate has no captured payment.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/duplicate-orders-from-a-double-submit/
"""
import os
import logging
from datetime import datetime, timedelta, timezone
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
WINDOW_SECONDS = int(os.environ.get("DUPLICATE_WINDOW_SECONDS", "300"))
LOOKBACK_MINUTES = int(os.environ.get("LOOKBACK_MINUTES", "15"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {"X-Auth-Token": TOKEN, "Accept": "application/json", "Content-Type": "application/json"}

PRE_FULFILLMENT_STATUS_IDS = {0, 1, 7, 9, 11}
CANCELLED_STATUS_ID = 5


def bc_get(path, params=None):
    r = requests.get(BASE + path, headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(BASE + path, headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def product_signature(products):
    """A stable string for a cart's contents, order does not matter."""
    parts = sorted(f"{p['product_id']}x{p['quantity']}" for p in products)
    return "|".join(parts)


def _parse(date_created):
    return datetime.strptime(date_created, "%a, %d %b %Y %H:%M:%S %z")


def find_duplicate_order_groups(orders, window_seconds=300):
    """Pure grouping and clustering logic. No I/O, no network.

    orders: list of {id, customer_id, date_created, total_inc_tax, status_id, product_signature}
    window_seconds: max gap between consecutive orders to still be one cluster
    returns: list of [keeper_id, *duplicate_ids], keeper is the earliest order in the cluster
    """
    eligible = [o for o in orders if o["status_id"] in PRE_FULFILLMENT_STATUS_IDS]

    groups = {}
    for o in eligible:
        key = (o["customer_id"], o["product_signature"], o["total_inc_tax"])
        groups.setdefault(key, []).append(o)

    duplicate_groups = []
    for members in groups.values():
        members = sorted(members, key=lambda o: _parse(o["date_created"]))
        cluster = [members[0]]
        for prev, curr in zip(members, members[1:]):
            delta = (_parse(curr["date_created"]) - _parse(prev["date_created"])).total_seconds()
            if delta <= window_seconds:
                cluster.append(curr)
            else:
                if len(cluster) > 1:
                    duplicate_groups.append([o["id"] for o in cluster])
                cluster = [curr]
        if len(cluster) > 1:
            duplicate_groups.append([o["id"] for o in cluster])

    return duplicate_groups


def recent_candidate_orders(min_date_created):
    orders = bc_get("v2/orders", {
        "min_date_created": min_date_created,
        "sort": "date_created:asc",
    })
    out = []
    for o in orders:
        if o["status_id"] not in PRE_FULFILLMENT_STATUS_IDS:
            continue
        products = bc_get(f"v2/orders/{o['id']}/products")
        out.append({
            "id": o["id"],
            "customer_id": o["customer_id"],
            "date_created": o["date_created"],
            "total_inc_tax": o["total_inc_tax"],
            "status_id": o["status_id"],
            "product_signature": product_signature(products),
        })
    return out


def has_settled_transaction(order_id):
    transactions = bc_get(f"v2/orders/{order_id}/transactions")
    return any(t.get("status") in ("captured", "authorized") for t in transactions)


def cancel_order(order_id):
    return bc_put(f"v2/orders/{order_id}", {"status_id": CANCELLED_STATUS_ID})


def run():
    min_date_created = (datetime.now(timezone.utc) - timedelta(minutes=LOOKBACK_MINUTES)).strftime(
        "%Y-%m-%dT%H:%M:%S+00:00"
    )
    orders = recent_candidate_orders(min_date_created)
    groups = find_duplicate_order_groups(orders, WINDOW_SECONDS)

    cancelled = 0
    flagged = 0
    for group in groups:
        keeper_id, *duplicate_ids = group
        for order_id in duplicate_ids:
            if has_settled_transaction(order_id):
                log.warning("Order %s has a captured transaction, flagging for manual refund then cancel.", order_id)
                flagged += 1
                continue
            log.info("Order %s is a duplicate of %s. %s", order_id, keeper_id,
                      "would cancel" if DRY_RUN else "cancelling")
            if not DRY_RUN:
                cancel_order(order_id)
            cancelled += 1

    log.info("Done. %d order(s) %s, %d flagged for manual review.",
              cancelled, "to cancel" if DRY_RUN else "cancelled", flagged)


if __name__ == "__main__":
    run()
