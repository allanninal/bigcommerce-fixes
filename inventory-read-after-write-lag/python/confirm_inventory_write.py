"""Confirm BigCommerce inventory adjustments instead of trusting the write's 200.

BigCommerce's Inventory API (PUT /v3/inventory/adjustments/absolute or /relative)
processes writes asynchronously. The call returns 200 with an action id (data.id)
as soon as the request is accepted into the processing pipeline, not after the new
quantity is durably committed and propagated to the read path. BigCommerce's own
docs describe this as eventual consistency: "there may be a short delay before
data is updated after the endpoints are called." A relative adjustment can even
race against a still-in-flight absolute adjustment's pre-check stage and apply
the pre-adjustment value. A GET immediately after a write can therefore return
the pre-write quantity with no error or signal that it is stale.

This script submits an adjustment, then polls the read endpoint with exponential
backoff until the observed quantity matches the expected quantity. If the poll
budget runs out first, it flags the adjustment for an operator instead of ever
calling /v3/inventory/adjustments again. Re-submitting a write to "fix" a stale
read risks double-applying a relative delta or masking a real failure downstream.

Guide: https://www.allanninal.dev/bigcommerce/inventory-read-after-write-lag/
"""
import os
import time
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("confirm_inventory_write")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "6"))
BASE_DELAY_S = float(os.environ.get("BASE_DELAY_S", "1.0"))
MAX_DELAY_S = float(os.environ.get("MAX_DELAY_S", "60.0"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def confirm_inventory_write(
    expected_quantity: int,
    observed_quantity,
    adjustment_id,
    attempt: int,
    max_attempts: int,
    base_delay_s: float = 1.0,
    max_delay_s: float = 60.0,
) -> dict:
    """Pure decision. No network, no side effects.

    Decide whether an inventory read confirms a prior write, and if not,
    whether to retry or flag.

    Returns {"status": "confirmed"|"retry"|"stale_flagged", "next_delay_s": float|None, "reason": str}

    if adjustment_id is None: status="stale_flagged", reason="missing action id, cannot confirm"
    elif observed_quantity == expected_quantity: status="confirmed"
    elif attempt >= max_attempts: status="stale_flagged", reason="poll budget exhausted"
    else: status="retry", next_delay_s=min(base_delay_s * (2 ** attempt), max_delay_s)
    """
    if adjustment_id is None:
        return {
            "status": "stale_flagged",
            "next_delay_s": None,
            "reason": "missing action id, cannot confirm",
        }
    if observed_quantity == expected_quantity:
        return {"status": "confirmed", "next_delay_s": None, "reason": "quantity matches"}
    if attempt >= max_attempts:
        return {
            "status": "stale_flagged",
            "next_delay_s": None,
            "reason": "poll budget exhausted",
        }
    delay = min(base_delay_s * (2 ** attempt), max_delay_s)
    return {"status": "retry", "next_delay_s": delay, "reason": "quantity not yet confirmed"}


def submit_adjustment(mode, reason, sku, location_id, quantity):
    """mode is 'absolute' or 'relative'."""
    body = {
        "reason": reason,
        "items": [{"sku": sku, "location_id": location_id, "quantity": quantity}],
    }
    return bc_put(f"/inventory/adjustments/{mode}", body)


def read_item(sku, location_id):
    data = bc_get("/inventory/items", {"location_ids": location_id, "skus": sku})
    rows = data.get("data") or []
    return rows[0] if rows else None


def confirm_write(sku, location_id, expected_quantity, adjustment_id):
    """Submit-independent confirmation loop. Only ever reads, never re-writes."""
    started = time.monotonic()
    attempt = 0
    observed = None
    while True:
        item = read_item(sku, location_id)
        observed = item.get("available_to_sell") if item else None
        decision = confirm_inventory_write(
            expected_quantity, observed, adjustment_id, attempt, MAX_ATTEMPTS,
            BASE_DELAY_S, MAX_DELAY_S,
        )
        if decision["status"] != "retry":
            elapsed_ms = int((time.monotonic() - started) * 1000)
            return decision, observed, attempt, elapsed_ms
        time.sleep(decision["next_delay_s"])
        attempt += 1


def run(sku, location_id, expected_quantity, mode="absolute", reason="stock recount"):
    log.info(
        "Submitting %s adjustment sku=%s location_id=%s expected_quantity=%s (%s)",
        mode, sku, location_id, expected_quantity, "dry run" if DRY_RUN else "writing",
    )

    if DRY_RUN:
        log.info("DRY_RUN=true, skipping the write and the confirmation poll.")
        return

    response = submit_adjustment(mode, reason, sku, location_id, expected_quantity)
    adjustment_id = (response.get("data") or {}).get("id")

    decision, observed, attempt, elapsed_ms = confirm_write(
        sku, location_id, expected_quantity, adjustment_id
    )

    if decision["status"] == "confirmed":
        log.info(
            "Confirmed sku=%s location_id=%s quantity=%s after %d attempt(s), %dms",
            sku, location_id, observed, attempt, elapsed_ms,
        )
        return

    record = {
        "adjustment_id": adjustment_id,
        "sku": sku,
        "location_id": location_id,
        "expected_quantity": expected_quantity,
        "last_observed_quantity": observed,
        "attempts": attempt,
        "elapsed_ms": elapsed_ms,
    }
    log.warning("STALE_FLAGGED %s reason=%s", record, decision["reason"])


if __name__ == "__main__":
    run(
        sku=os.environ.get("SKU", "example-sku"),
        location_id=int(os.environ.get("LOCATION_ID", "1")),
        expected_quantity=int(os.environ.get("EXPECTED_QUANTITY", "0")),
    )
