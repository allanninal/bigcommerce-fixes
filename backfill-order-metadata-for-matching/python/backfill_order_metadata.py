"""Backfill a reconciliation key onto legacy BigCommerce orders, safely.

Orders placed before an ERP, marketplace, or order-management integration was
wired up were created without external_id, external_merchant_id, or
external_source, because those fields are only populated by whichever client
submits the order at creation time. BigCommerce treats external_merchant_id as
write-once (a PUT to change it returns a 400) and external_id behaves the same
way once the order already exists, so those fields cannot be safely rewritten
after the fact. This scans the pre-cutover window, matches each unmatched order
against an external export, and writes an idempotent reconciliation tag into
staff_notes instead, which stays mutable for the life of the order.
Run on a schedule or once per migration batch. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/backfill-order-metadata-for-matching/
"""
import os
import logging
from datetime import datetime, timezone
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_order_metadata")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
HEADERS = {"X-Auth-Token": TOKEN, "Accept": "application/json", "Content-Type": "application/json"}

MIGRATION_CUTOFF = os.environ.get("MIGRATION_CUTOFF", "2025-01-01T00:00:00+00:00")
CUTOVER_DATE = os.environ.get("CUTOVER_DATE", "2025-06-01T00:00:00+00:00")
MATCH_CONFIDENCE_THRESHOLD = float(os.environ.get("MATCH_CONFIDENCE_THRESHOLD", "0.8"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VOID_STATUS_IDS = {0, 5, 6}  # Incomplete, Cancelled, Declined
EXPECTED_SOURCE_TAGS = {"M-MIG"}


def bc_get(path, params=None):
    r = requests.get(BASE + path, headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(BASE + path, headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def needs_backfill(order):
    if order.get("external_id"):
        return False
    if order.get("external_merchant_id"):
        return False
    source = order.get("external_source")
    if source and source in EXPECTED_SOURCE_TAGS:
        return False
    return True


def decide_backfill_action(order, candidate_match, now_iso):
    """Pure decision logic. No I/O, fully testable with plain dicts.

    order: dict with at least status_id, staff_notes, external_id, external_merchant_id
    candidate_match: None, or dict with external_id, source, confidence
    now_iso: an ISO 8601 timestamp string
    """
    if order["status_id"] in VOID_STATUS_IDS:
        return {"action": "skip", "reason": "incomplete_or_voided"}

    existing_notes = order.get("staff_notes") or ""
    if "[RECON:" in existing_notes:
        return {"action": "skip", "reason": "already_tagged"}

    if order.get("external_id") or order.get("external_merchant_id"):
        return {"action": "skip", "reason": "already_has_external_key"}

    if candidate_match is None or candidate_match.get("confidence", 0) < MATCH_CONFIDENCE_THRESHOLD:
        return {
            "action": "flag_unmatched",
            "new_staff_notes": existing_notes + f"\n[RECON:UNMATCHED;checked={now_iso}]",
        }

    return {
        "action": "write_staff_notes",
        "new_staff_notes": existing_notes
        + f"\n[RECON:ext_id={candidate_match['external_id']};"
        + f"source={candidate_match.get('source', 'M-MIG')};matched={now_iso}]",
    }


def scan_candidate_orders():
    orders = bc_get("v2/orders", {
        "min_date_created": MIGRATION_CUTOFF,
        "max_date_created": CUTOVER_DATE,
        "is_deleted": "false",
        "sort": "id",
        "limit": 250,
    })
    out = []
    for stub in orders:
        full = bc_get(f"v2/orders/{stub['id']}")
        if needs_backfill(full):
            out.append(full)
    return out


def find_candidate_match(order, erp_export):
    """Match by customer_id, billing email, total, and a date tolerance window.
    Replace with your real ERP export lookup. Returns None or a dict with
    external_id, source, and confidence.
    """
    return erp_export.get(order["id"])


def apply_staff_notes(order_id, new_staff_notes):
    fresh = bc_get(f"v2/orders/{order_id}")
    if "[RECON:" in (fresh.get("staff_notes") or ""):
        return  # another run already tagged it, idempotent no-op
    return bc_put(f"v2/orders/{order_id}", {"staff_notes": new_staff_notes})


def run(erp_export=None):
    erp_export = erp_export or {}
    now_iso = datetime.now(timezone.utc).isoformat()

    written = 0
    unmatched = 0
    skipped = 0
    for order in scan_candidate_orders():
        candidate_match = find_candidate_match(order, erp_export)
        decision = decide_backfill_action(order, candidate_match, now_iso)

        if decision["action"] == "skip":
            skipped += 1
            continue

        log.info(
            "Order %s -> %s. %s",
            order["id"], decision["action"], "would write" if DRY_RUN else "writing",
        )
        if not DRY_RUN:
            apply_staff_notes(order["id"], decision["new_staff_notes"])

        if decision["action"] == "write_staff_notes":
            written += 1
        else:
            unmatched += 1

    log.info(
        "Done. %d order(s) %s, %d flagged unmatched, %d skipped.",
        written, "to reconcile" if DRY_RUN else "reconciled", unmatched, skipped,
    )


if __name__ == "__main__":
    run()
