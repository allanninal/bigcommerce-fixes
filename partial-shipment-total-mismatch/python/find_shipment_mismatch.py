"""Reconcile BigCommerce orders whose shipped quantity does not add up.

An order's status_id is rolled up from summing quantity_shipped across its
line items on GET /v2/orders/{id}/products. Shipments are created in batches
through POST /v2/orders/{id}/shipments, so a duplicated call, a shipment
posted against an already-refunded line, or a dropped webhook retry can push
the shipped total above or leave it below the true ordered quantity. This
reads each candidate order's line items and its independent shipment ledger,
classifies the mismatch with classify_shipment_mismatch, safely corrects the
status_id for the two well-defined stuck-partial cases, and flags every other
mismatch to staff_notes for a human to reconcile against the WMS. It never
deletes, edits, or recreates a shipment record. Run on a schedule. Safe to
run again and again.

Guide: https://www.allanninal.dev/bigcommerce/partial-shipment-total-mismatch/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_shipment_mismatch")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
MIN_DATE_MODIFIED = os.environ.get("MIN_DATE_MODIFIED", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CANDIDATE_STATUS_IDS = {2, 3, 14}
CORRECTED_STATUS_ID = {"stuck_partial_done": 2, "stuck_partial_unshipped": 11}
AUTO_CORRECT_VERDICTS = set(CORRECTED_STATUS_ID)


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def classify_shipment_mismatch(ordered_qty: int, quantity_shipped: int, quantity_refunded: int,
                                shipment_ledger_qty: int, order_status_id: int) -> str:
    """
    Pure decision logic, no I/O. Returns one of:
      "ledger_drift"        -> BC's cached quantity_shipped disagrees with the sum of shipment records (case a)
      "over_fulfilled"      -> shipped + refunded exceeds what was ordered (case b)
      "stuck_partial_done"  -> fully shipped per ledger but status_id still 3 (case c)
      "stuck_partial_unshipped" -> nothing shipped/refunded but status_id is 3 (case d)
      "ok"                  -> no mismatch detected

    Precedence: ledger_drift and over_fulfilled (data integrity issues) take priority
    over the status-only issues (c/d), which are safe to auto-correct.
    """
    if shipment_ledger_qty != quantity_shipped:
        return "ledger_drift"
    if quantity_shipped + quantity_refunded > ordered_qty:
        return "over_fulfilled"
    if order_status_id == 3 and quantity_shipped == ordered_qty:
        return "stuck_partial_done"
    if order_status_id == 3 and quantity_shipped == 0 and quantity_refunded == 0:
        return "stuck_partial_unshipped"
    return "ok"


def orders_to_check():
    page = 1
    while True:
        params = f"page={page}&limit=50"
        if MIN_DATE_MODIFIED:
            params += f"&min_date_modified={MIN_DATE_MODIFIED}"
        rows = bc("GET", f"/v2/orders?{params}")
        if not rows:
            return
        for row in rows:
            if int(row["status_id"]) in CANDIDATE_STATUS_IDS:
                yield row
        page += 1


def order_line_items(order_id):
    return bc("GET", f"/v2/orders/{order_id}/products") or []


def shipment_ledger_by_line(order_id):
    shipments = bc("GET", f"/v2/orders/{order_id}/shipments") or []
    totals = {}
    for shipment in shipments:
        for item in shipment.get("items", []):
            key = item["order_product_id"]
            totals[key] = totals.get(key, 0) + int(item["quantity"])
    return totals


def correct_status(order_id, verdict):
    return bc("PUT", f"/v2/orders/{order_id}", json={"status_id": CORRECTED_STATUS_ID[verdict]})


def flag_for_review(order_id, verdict, line_summary):
    note = f"SHIPMENT_MISMATCH[{verdict}]: {line_summary}"
    return bc("PUT", f"/v2/orders/{order_id}", json={"staff_notes": note})


def run():
    corrected = 0
    flagged = 0
    for row in orders_to_check():
        order_id = row["id"]
        status_id = int(row["status_id"])
        ledger = shipment_ledger_by_line(order_id)
        for line in order_line_items(order_id):
            line_id = line["id"]
            ordered_qty = int(line["quantity"])
            quantity_shipped = int(line.get("quantity_shipped", 0))
            quantity_refunded = int(line.get("quantity_refunded", 0))
            ledger_qty = ledger.get(line_id, 0)
            verdict = classify_shipment_mismatch(
                ordered_qty, quantity_shipped, quantity_refunded, ledger_qty, status_id
            )
            if verdict == "ok":
                continue
            summary = (f"order={order_id} line={line_id} ordered={ordered_qty} "
                       f"shipped={quantity_shipped} refunded={quantity_refunded} "
                       f"ledger={ledger_qty} status_id={status_id}")
            if verdict in AUTO_CORRECT_VERDICTS:
                log.info("%s. %s %s", verdict, summary, "would correct" if DRY_RUN else "correcting")
                if not DRY_RUN:
                    correct_status(order_id, verdict)
                corrected += 1
            else:
                log.warning("%s. %s %s", verdict, summary, "would flag" if DRY_RUN else "flagging")
                if not DRY_RUN:
                    flag_for_review(order_id, verdict, summary)
                flagged += 1
    log.info(
        "Done. %d order(s) %s, %d order(s) %s.",
        corrected, "to correct" if DRY_RUN else "corrected",
        flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
