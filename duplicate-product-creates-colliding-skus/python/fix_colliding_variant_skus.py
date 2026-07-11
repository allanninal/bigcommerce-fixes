"""Find and optionally repair BigCommerce variants left with colliding SKUs
after a product duplication.

When BigCommerce duplicates a product, in the admin or through a script
cloning it via the Catalog API, it copies the full variant option matrix but
does not mint new SKU values for the cloned variants. It either repeats the
source product's SKU verbatim across every variant row or leaves them blank.
BigCommerce only enforces SKU uniqueness as a write-time constraint, a 409
Conflict on save, rather than auto-generating a unique SKU at duplication
time, so the copy silently persists with colliding SKUs until something else
tries to write or match on one. This job walks the catalog, groups each
product's variant SKUs, and reports every collision. Renaming is gated
behind an explicit --apply flag and DRY_RUN guard, because a SKU can be
keyed against an external inventory or ERP system.

Guide: https://www.allanninal.dev/bigcommerce/duplicate-product-creates-colliding-skus/
"""
import os
import sys
import csv
import json
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_colliding_variant_skus")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
APPLY = "--apply" in sys.argv

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


def find_sku_collisions(variants):
    """Pure decision. No network, no side effects.

    Takes a flat list of variant records, each with product_id, variant_id,
    sku, and option_values. Normalizes sku via sku.strip().lower(), groups
    variants by (product_id, normalized_sku), drops blank SKUs (not a
    collision), and returns only groups with more than one variant, keyed by
    "{product_id}:{sku}".
    """
    groups = {}
    for v in variants:
        normalized_sku = (v.get("sku") or "").strip().lower()
        if normalized_sku == "":
            continue
        key = f'{v["product_id"]}:{normalized_sku}'
        groups.setdefault(key, []).append(v)

    return {key: rows for key, rows in groups.items() if len(rows) > 1}


def all_products_with_variants():
    """Page through every product with its variants embedded."""
    path = "/catalog/products"
    params = {"include": "variants", "limit": 250}
    while path:
        payload = bc_get(path, params) if params else bc_get(path)
        for product in payload["data"]:
            yield product
        next_url = payload.get("meta", {}).get("pagination", {}).get("links", {}).get("next")
        path, params = (next_url, None) if next_url else (None, None)


def flatten_variants(products):
    for product in products:
        for variant in product.get("variants") or []:
            yield {
                "product_id": product["id"],
                "variant_id": variant["id"],
                "sku": variant.get("sku") or "",
                "option_values": variant.get("option_values") or [],
            }


def rename_duplicate(product_id, variant_id, original_sku):
    new_sku = f"{original_sku}-{variant_id}"
    return bc_put(f"/catalog/products/{product_id}/variants/{variant_id}", {"sku": new_sku})


def write_report(collisions, path="sku_collisions.csv"):
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["product_id", "variant_id", "sku", "option_values"])
        for rows in collisions.values():
            for row in rows:
                writer.writerow([
                    row["product_id"],
                    row["variant_id"],
                    row["sku"],
                    json.dumps(row["option_values"]),
                ])
    return path


def run():
    products = list(all_products_with_variants())
    variants = list(flatten_variants(products))
    collisions = find_sku_collisions(variants)

    if not collisions:
        log.info("No colliding SKUs found across %d product(s).", len(products))
        return

    report_path = write_report(collisions)
    log.info(
        "Found %d colliding SKU group(s) across %d product(s). Report written to %s",
        len(collisions), len(products), report_path,
    )

    for key, rows in collisions.items():
        log.warning(
            "Collision %s: %s",
            key,
            [{"variant_id": r["variant_id"], "option_values": r["option_values"]} for r in rows],
        )

    if not APPLY:
        log.info("Report only. Pass --apply and set DRY_RUN=false to rename duplicates.")
        return

    renamed = 0
    for rows in collisions.values():
        keep, duplicates = rows[0], rows[1:]
        log.info("Keeping original sku=%s on variant_id=%s", keep["sku"], keep["variant_id"])
        for dup in duplicates:
            if DRY_RUN:
                log.info(
                    "Would rename variant_id=%s sku=%s -> %s-%s",
                    dup["variant_id"], dup["sku"], dup["sku"], dup["variant_id"],
                )
            else:
                rename_duplicate(dup["product_id"], dup["variant_id"], dup["sku"])
                log.info("Renamed variant_id=%s sku=%s -> %s-%s",
                         dup["variant_id"], dup["sku"], dup["sku"], dup["variant_id"])
            renamed += 1

    log.info("Done. %d duplicate variant(s) %s.", renamed, "would be renamed" if DRY_RUN else "renamed")


if __name__ == "__main__":
    run()
