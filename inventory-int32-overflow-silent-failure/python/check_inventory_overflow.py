"""Detect BigCommerce variant inventory writes that silently fail past int32 max.

BigCommerce's Catalog v3 API stores inventory_level as a 32-bit signed integer
with a ceiling of 2147483647, and it enforces that ceiling against the product's
summed variant inventory, not just the single variant being written. A write via
PUT /v3/catalog/products/{id}/variants/{variant_id}, the Update Products batch
endpoint, or POST /v3/inventory/adjustments/absolute|relative that would push that
sum over the ceiling does not get clamped and does not return a validation error.
It returns HTTP 200 and the stored inventory_level is left unchanged. This job
predicts the overflow before writing using only pre-fetched variant levels (no
network call needed for the decision itself), and after every write it re-reads
the same variant directly to confirm the value actually changed. Everything it
finds is reported, nothing is auto-corrected. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/inventory-int32-overflow-silent-failure/
"""
import os
import logging
from typing import NamedTuple

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_inventory_overflow")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

INT32_MAX = 2147483647

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


class VariantLevel(NamedTuple):
    id: int
    level: int


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def would_overflow_and_be_dropped(
    current_variant_levels: list, variant_id: int, new_level: int, int32_max: int = INT32_MAX
):
    """Pure decision. No network, no side effects.

    total_excluding_target = sum of every other variant's inventory_level.
    projected_sum = total_excluding_target + new_level.
    is_unsafe when projected_sum exceeds int32_max, or when new_level alone
    already exceeds int32_max. Returns (is_unsafe, projected_sum) so the caller
    can log the projected total whether or not it is unsafe.
    """
    total_excluding_target = sum(
        v.level for v in current_variant_levels if v.id != variant_id
    )
    projected_sum = total_excluding_target + new_level
    is_unsafe = projected_sum > int32_max or new_level > int32_max
    return is_unsafe, projected_sum


def list_variants(product_id):
    page = 1
    variants = []
    while True:
        resp = bc_get(
            f"/catalog/products/{product_id}/variants",
            {"limit": 250, "page": page, "include_fields": "id,sku,inventory_level"},
        )
        rows = resp.get("data", [])
        if not rows:
            return variants
        variants.extend(rows)
        page += 1


def get_variant(product_id, variant_id):
    resp = bc_get(f"/catalog/products/{product_id}/variants/{variant_id}")
    return resp["data"]


def write_variant_inventory_level(product_id, variant_id, new_level):
    return bc_put(
        f"/catalog/products/{product_id}/variants/{variant_id}",
        {"inventory_level": new_level},
    )


def check_and_apply(product_id, variant_id, sku, new_level):
    """Predict, then write if safe, then re-read to confirm. Returns a report dict or None."""
    variants = list_variants(product_id)
    levels = [VariantLevel(id=v["id"], level=v.get("inventory_level") or 0) for v in variants]

    before = get_variant(product_id, variant_id)
    current_persisted = before.get("inventory_level")

    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id, new_level)

    if is_unsafe:
        log.warning(
            "Predicted overflow: product_id=%s variant_id=%s sku=%s "
            "attempted=%s current=%s projected_sum=%s",
            product_id, variant_id, sku, new_level, current_persisted, projected_sum,
        )
        return {
            "product_id": product_id,
            "variant_id": variant_id,
            "sku": sku,
            "attempted_inventory_level": new_level,
            "current_persisted_inventory_level": current_persisted,
            "projected_sum": projected_sum,
        }

    if DRY_RUN:
        log.info(
            "Dry run, would write: product_id=%s variant_id=%s sku=%s "
            "attempted=%s current=%s projected_sum=%s",
            product_id, variant_id, sku, new_level, current_persisted, projected_sum,
        )
        return None

    write_variant_inventory_level(product_id, variant_id, new_level)
    after = get_variant(product_id, variant_id)

    if after.get("inventory_level") == current_persisted and new_level != current_persisted:
        log.warning(
            "Silent failure detected: product_id=%s variant_id=%s sku=%s "
            "attempted=%s current=%s (unchanged after 200 response) projected_sum=%s",
            product_id, variant_id, sku, new_level, current_persisted, projected_sum,
        )
        return {
            "product_id": product_id,
            "variant_id": variant_id,
            "sku": sku,
            "attempted_inventory_level": new_level,
            "current_persisted_inventory_level": after.get("inventory_level"),
            "projected_sum": projected_sum,
        }

    return None


def run(pending_writes):
    """pending_writes: iterable of (product_id, variant_id, sku, new_level)."""
    reports = []
    for product_id, variant_id, sku, new_level in pending_writes:
        report = check_and_apply(product_id, variant_id, sku, new_level)
        if report:
            reports.append(report)

    log.info("Done. %d mismatch(es) reported.", len(reports))
    return reports


if __name__ == "__main__":
    run([])
