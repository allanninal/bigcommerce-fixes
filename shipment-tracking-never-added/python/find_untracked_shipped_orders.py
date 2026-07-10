"""Flag BigCommerce orders marked Shipped that never got a real tracking number.

POST /v2/orders/{id}/shipments only requires order_address_id and items.
tracking_number is optional, alongside tracking_link and shipping_provider.
That means the Ship Items modal in the control panel, or a connected OMS or
3PL such as ShipStation, Cin7, or ShipHero, can create a shipment with the
Tracking ID box left blank, or an integration can move status_id straight to
2 (Shipped) with PUT /v2/orders/{id} and skip shipment creation entirely.
Either way, the order looks fulfilled while the customer has no way to track
their package, and the automated shipping confirmation email's tracking link
points nowhere. This job lists orders in status_id 2 (Shipped), 3 (Partially
Shipped), and 10 (Completed), reads each order's shipments, and flags only
the ones older than a grace window that have zero shipment records or whose
shipments all carry empty tracking_number, tracking_link, and
shipping_provider fields. It never fabricates a tracking number, it only
leaves a note for a human to fill in the real one. Run on a schedule. Safe
to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/shipment-tracking-never-added/
"""
import os
import logging
from datetime import datetime, timezone, timedelta

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_untracked_shipped_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SHIPPED_LIKE_STATUSES = {2, 3, 10}  # Shipped, Partially Shipped, Completed

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


def _is_blank(value):
    return not (value or "").strip()


def find_untracked_shipped_orders(orders, shipments_by_order_id, now, grace_hours=24):
    """Pure decision. No network, no side effects.

    Considers only orders in status_id 2, 3, or 10, and only once date_modified
    is older than grace_hours, so an order the 3PL shipped moments ago is not
    flagged before tracking has had a chance to post. An order with an empty
    shipments list is flagged no_shipment_record. An order whose shipments all
    have empty tracking_number, tracking_link, and shipping_provider is flagged
    shipment_missing_tracking. Anything else is left alone.
    """
    flagged = []
    for order in orders:
        if order["status_id"] not in SHIPPED_LIKE_STATUSES:
            continue

        modified = order["date_modified"]
        if isinstance(modified, str):
            modified = datetime.fromisoformat(modified.replace("Z", "+00:00"))
        if now - modified < timedelta(hours=grace_hours):
            continue

        shipments = shipments_by_order_id.get(order["id"], [])
        if not shipments:
            flagged.append({"orderId": order["id"], "reason": "no_shipment_record"})
            continue

        all_missing_tracking = all(
            _is_blank(s.get("tracking_number")) and _is_blank(s.get("tracking_link")) and _is_blank(s.get("shipping_provider"))
            for s in shipments
        )
        if all_missing_tracking:
            flagged.append({"orderId": order["id"], "reason": "shipment_missing_tracking"})

    return flagged


def shipped_like_orders():
    """Page through orders in status_id 2, 3, and 10 within the lookback window."""
    for status_id in SHIPPED_LIKE_STATUSES:
        page = 1
        while True:
            orders = bc_get(
                "/orders",
                {
                    "status_id": status_id,
                    "min_date_modified": f"-{LOOKBACK_DAYS} days",
                    "page": page,
                    "limit": 250,
                },
            )
            if not orders:
                break
            for order in orders:
                yield order
            page += 1


def order_shipments(order_id):
    return bc_get(f"/orders/{order_id}/shipments")


def append_staff_note(order_id, existing_notes, message):
    note = (existing_notes or "").rstrip()
    updated = f"{note}\n{message}".strip() if note else message
    return bc_put(f"/orders/{order_id}", {"staff_notes": updated})


def run():
    now = datetime.now(timezone.utc)
    orders = list(shipped_like_orders())
    shipments_by_order_id = {order["id"]: order_shipments(order["id"]) for order in orders}

    flagged = find_untracked_shipped_orders(orders, shipments_by_order_id, now, GRACE_HOURS)

    for item in flagged:
        order_id = item["orderId"]
        reason = item["reason"]
        log.warning(
            "order_id=%s reason=%s %s",
            order_id, reason,
            "would flag with staff_notes" if DRY_RUN else "flagging with staff_notes",
        )
        if not DRY_RUN:
            order = next((o for o in orders if o["id"] == order_id), {})
            message = f"ALERT: order marked Shipped on {now.date()} with no tracking number, verify with fulfillment."
            append_staff_note(order_id, order.get("staff_notes"), message)

    log.info("Done. %d order(s) %s.", len(flagged), "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
