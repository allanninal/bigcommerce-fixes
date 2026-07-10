"""Flag BigCommerce orders stuck Awaiting Shipment past a shipping SLA.

BigCommerce moves a paid order into status_id 11 (Awaiting Fulfillment)
automatically once payment captures, and merchants or OMS integrations move
it to status_id 9 (Awaiting Shipment) once picked and packed. Neither status
has a built-in SLA clock or aging alert, so an order only leaves Awaiting
Shipment when someone explicitly posts a shipment. Orders age silently past
a shipping promise whenever a warehouse task is missed, a 3PL or OMS sync
fails, or the store/order/statusUpdated webhook that would have notified an
external fulfillment system was auto-deactivated by BigCommerce after
repeated non-2xx responses and never recreated. This job lists orders in
status_id 9, 11, and 8, confirms each candidate's payment actually settled
and that no shipment already exists, computes how far past the SLA it is,
and flags only the genuinely overdue ones with a note on staff_notes. It
never marks an order shipped and never fabricates a shipment record. Run on
a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/orders-stuck-awaiting-shipment-past-sla/
"""
import os
import logging
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_overdue_awaiting_shipment")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
SLA_HOURS = float(os.environ.get("SLA_HOURS", "48"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CANDIDATE_STATUSES = (9, 11, 8)  # Awaiting Shipment, Awaiting Fulfillment, Awaiting Pickup
TARGET_STATUS_IDS = {9, 11}
SETTLED_TRANSACTION_TYPES = {"capture", "settled", "sale"}

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


def has_captured_payment(transactions):
    return any((t.get("type") or "").lower() in SETTLED_TRANSACTION_TYPES for t in transactions or [])


def find_overdue_orders(orders, now, sla_hours, target_status_ids=None):
    """Pure decision. No network, no side effects.

    Filters orders down to status_id 9 or 11 (or a caller-supplied set),
    excludes any order that already has a shipment (the status just has not
    synced yet) or whose payment is not captured (guards against Awaiting
    Payment or a declined order masquerading under the wrong status_id),
    computes age_hours from date_created, and keeps only the orders older
    than sla_hours. Returns overdue orders sorted by overage_hours
    descending, so the worst breaches surface first.
    """
    if target_status_ids is None:
        target_status_ids = TARGET_STATUS_IDS

    overdue = []
    for order in orders:
        if order["status_id"] not in target_status_ids:
            continue
        if order.get("has_shipment"):
            continue
        if order.get("payment_status") != "captured":
            continue

        created = order["date_created"]
        if isinstance(created, str):
            created = datetime.fromisoformat(created.replace("Z", "+00:00"))
        age_hours = (now - created).total_seconds() / 3600

        if age_hours > sla_hours:
            overdue.append({
                "order_id": order["id"],
                "status_id": order["status_id"],
                "date_created": created,
                "age_hours": age_hours,
                "overage_hours": age_hours - sla_hours,
            })

    overdue.sort(key=lambda o: o["overage_hours"], reverse=True)
    return overdue


def candidate_orders():
    """Page through orders in the staging statuses that can age past an SLA."""
    for status_id in CANDIDATE_STATUSES:
        page = 1
        while True:
            orders = bc_get("/orders", {"status_id": status_id, "page": page, "limit": 250})
            if not orders:
                break
            for order in orders:
                yield order
            page += 1


def order_transactions(order_id):
    return bc_get(f"/orders/{order_id}/transactions")


def order_shipments(order_id):
    return bc_get(f"/orders/{order_id}/shipments")


def append_sla_note(order_id, existing_notes, message):
    note = (existing_notes or "").rstrip()
    updated = f"{note}\n{message}".strip() if note else message
    return bc_put(f"/orders/{order_id}", {"staff_notes": updated})


def run():
    now = datetime.now(timezone.utc)
    orders = list(candidate_orders())

    enriched = []
    for order in orders:
        transactions = order_transactions(order["id"])
        shipments = order_shipments(order["id"])
        enriched.append({
            **order,
            "payment_status": "captured" if has_captured_payment(transactions) else "uncaptured",
            "has_shipment": len(shipments) > 0,
        })

    overdue = find_overdue_orders(enriched, now, SLA_HOURS)

    for item in overdue:
        message = (
            f"[SLA-ALERT] Awaiting Shipment since {item['date_created']}, "
            f"{item['age_hours']:.1f}h over the {SLA_HOURS:.0f}h promise "
            f"- flagged {now.isoformat()}"
        )
        log.warning(
            "order_id=%s age_hours=%.1f overage_hours=%.1f %s",
            item["order_id"], item["age_hours"], item["overage_hours"],
            "would tag" if DRY_RUN else "tagging",
        )
        if not DRY_RUN:
            order = next((o for o in orders if o["id"] == item["order_id"]), {})
            append_sla_note(item["order_id"], order.get("staff_notes"), message)

    log.info("Done. %d order(s) %s.", len(overdue), "to tag" if DRY_RUN else "tagged")


if __name__ == "__main__":
    run()
