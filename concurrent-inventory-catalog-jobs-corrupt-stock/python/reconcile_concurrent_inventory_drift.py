"""Detect and repair BigCommerce stock corrupted by concurrent bulk jobs.

BigCommerce's Inventory API processes absolute and relative adjustments
asynchronously through its own internal queue, and its documentation warns
that running Inventory API bulk operations in parallel with Catalog API or
Orders API bulk operations "may cause unpredictable, incorrect calculation
results." Relative adjustments do a read-modify-write against the current
stored total_inventory_onhand, so a catalog bulk edit that also touches
inventory_level, or an order bulk job decrementing stock, can race an
inventory adjustment job on the same SKU and location and silently clobber
or double-apply it. There is also a documented propagation delay between an
adjustment call returning 200 and the new value being reliably readable via
GET, which widens the race window.

BigCommerce does not expose a public adjustment audit-trail endpoint, so
this job reconstructs the expected on-hand for each SKU and location from
the integration's own adjustment ledger, compares it against the actual
total_inventory_onhand BigCommerce reports, and pushes a corrective
absolute adjustment only where the two disagree beyond a tolerance. Every
write is re-verified with a fresh GET before the SKU is marked reconciled.
Run once after any window where inventory and catalog or order bulk jobs
overlapped, then gate all future jobs behind a per-store_hash mutex so this
does not happen again.

Guide: https://www.allanninal.dev/bigcommerce/concurrent-inventory-catalog-jobs-corrupt-stock/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_concurrent_inventory_drift")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
STOCK_TOLERANCE = int(os.environ.get("STOCK_TOLERANCE", "0"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

MAX_ITEMS_PER_ADJUSTMENT_CALL = 2000

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def is_inventory_corrupted(actual_on_hand: int, expected_on_hand: int, tolerance: int = 0) -> bool:
    """Pure decision. No network, no side effects.

    Returns True (flag for repair) when the actual on-hand BigCommerce
    reports differs from the expected on-hand reconstructed from our own
    adjustment ledger by more than tolerance. Returns False otherwise.
    """
    return abs(actual_on_hand - expected_on_hand) > tolerance


def build_correction_payload(sku: str, location_id: int, expected_on_hand: int) -> dict:
    """Pure payload builder. No network, no side effects.

    Returns the exact item dict the absolute-adjustment request body
    expects for one SKU and location.
    """
    return {"location_id": location_id, "sku": sku, "quantity": expected_on_hand}


def touched_products(job_start_ts):
    """Page through products and variants modified since job_start_ts."""
    page = 1
    while True:
        resp = bc_get(
            "/catalog/products",
            {
                "include": "variants",
                "date_modified:min": job_start_ts,
                "page": page,
                "limit": 250,
            },
        )
        rows = resp.get("data", [])
        if not rows:
            return
        for product in rows:
            yield product
        page += 1


def actual_inventory_items(location_id, skus):
    """Read current total_inventory_onhand for a batch of SKUs at a location."""
    if not skus:
        return []
    resp = bc_get(f"/inventory/locations/{location_id}/items", {"sku__in": ",".join(skus)})
    return resp.get("data", [])


def expected_on_hand_from_ledger(sku, location_id, ledger):
    """Reconstruct expected on-hand from our own adjustment log.

    ledger maps (sku, location_id) -> expected on-hand, built from a
    baseline plus every relative or absolute adjustment this integration
    issued during the overlapping window. BigCommerce does not expose a
    public adjustment audit-trail endpoint, so this ledger has to be kept
    by the integration itself.
    """
    return ledger.get((sku, location_id))


def push_absolute_adjustment(items):
    body = {"reason": "reconciliation-after-concurrent-jobs", "items": items}
    return bc_put("/inventory/adjustments/absolute", body)


def batched(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def run(job_start_ts=None, ledger=None):
    """ledger: dict mapping (sku, location_id) -> expected on-hand int.

    In production this is built from the integration's own persisted
    adjustment history, not passed in by hand.
    """
    job_start_ts = job_start_ts or os.environ.get("JOB_START_TS")
    ledger = ledger or {}

    if not job_start_ts:
        raise SystemExit(
            "run() needs job_start_ts and a persisted adjustment ledger from your own "
            "integration. Call run(job_start_ts, ledger) from your scheduler."
        )

    flagged = []

    for product in touched_products(job_start_ts):
        variants = product.get("variants") or [{
            "sku": product.get("sku"),
            "inventory_level": product.get("inventory_level"),
        }]
        for variant in variants:
            sku = variant.get("sku")
            if not sku:
                continue
            for location_id in sorted({loc for (s, loc) in ledger if s == sku}):
                items = actual_inventory_items(location_id, [sku])
                for item in items:
                    actual = item.get("total_inventory_onhand")
                    expected = expected_on_hand_from_ledger(sku, location_id, ledger)
                    if actual is None or expected is None:
                        continue
                    if is_inventory_corrupted(actual, expected, STOCK_TOLERANCE):
                        flagged.append((sku, location_id, actual, expected))

    log.info("Found %d SKU/location pair(s) with drift beyond tolerance %d.", len(flagged), STOCK_TOLERANCE)

    corrected = 0
    for batch in batched(flagged, MAX_ITEMS_PER_ADJUSTMENT_CALL):
        payload_items = [
            build_correction_payload(sku, location_id, expected)
            for (sku, location_id, actual, expected) in batch
        ]
        for (sku, location_id, actual, expected) in batch:
            log.info(
                "sku=%s location_id=%s actual_on_hand=%s expected_on_hand=%s (%s)",
                sku, location_id, actual, expected,
                "dry run" if DRY_RUN else "correcting",
            )
        if DRY_RUN:
            continue

        push_absolute_adjustment(payload_items)

        by_location = {}
        for (sku, location_id, _actual, expected) in batch:
            by_location.setdefault(location_id, []).append((sku, expected))

        for location_id, sku_expected in by_location.items():
            skus = [sku for (sku, _e) in sku_expected]
            verify_items = actual_inventory_items(location_id, skus)
            verify_by_sku = {i.get("sku"): i.get("total_inventory_onhand") for i in verify_items}
            for sku, expected in sku_expected:
                if verify_by_sku.get(sku) == expected:
                    corrected += 1
                else:
                    log.warning(
                        "Re-verify failed for sku=%s location_id=%s expected=%s got=%s",
                        sku, location_id, expected, verify_by_sku.get(sku),
                    )

    log.info(
        "Done. %d SKU/location pair(s) %s.",
        len(flagged), "would be corrected" if DRY_RUN else f"corrected ({corrected} re-verified)",
    )


if __name__ == "__main__":
    run()
