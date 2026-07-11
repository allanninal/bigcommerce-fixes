"""Report BigCommerce variants whose price no longer follows the product price.

A variant's price field is nullable and independent of the parent product's
price. If it is null, the storefront falls back to the product's default
price, but once a merchant or an API call sets an explicit numeric value on
that variant, it decouples permanently. A later PUT that updates the
product's price never cascades to variants that already carry a non-null
price, sale_price, or retail_price, and the API returns 200 with no warning
that variants were left behind. This job pages the full catalog with
variants included, compares each variant's price against its product's
price using Decimal arithmetic, and writes a report of every divergence.
A diverging variant price can be intentional (a size or material upcharge),
so nothing is reset automatically. Only variant ids the merchant explicitly
confirms are passed to reset_variant_price, and even then DRY_RUN gates the
real write. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/variant-price-override-breaks-inheritance/
"""
import csv
import json
import logging
import os
import sys
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_stale_variant_prices")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

DEFAULT_EPSILON = "0.0001"


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def find_stale_variant_overrides(product, variants, epsilon=DEFAULT_EPSILON):
    """Pure decision. No network, no side effects.

    product: {"id": int, "price": str}
    variants: list of {"id": int, "sku": str, "price": str | None}

    Returns one entry per variant whose non-null price differs from
    product["price"] by more than epsilon, using Decimal arithmetic only
    on inputs already fetched. A null or empty variant price means the
    variant is still inheriting and is never a finding.
    """
    try:
        product_price = Decimal(str(product["price"]))
    except (InvalidOperation, KeyError, TypeError):
        return []

    try:
        eps = Decimal(str(epsilon))
    except InvalidOperation:
        eps = Decimal(DEFAULT_EPSILON)

    findings = []
    for variant in variants or []:
        raw_price = variant.get("price")
        if raw_price is None or raw_price == "":
            continue

        try:
            variant_price = Decimal(str(raw_price))
        except InvalidOperation:
            continue

        delta = variant_price - product_price
        if abs(delta) <= eps:
            continue

        findings.append({
            "variant_id": variant.get("id"),
            "sku": variant.get("sku"),
            "product_price": str(product_price),
            "variant_price": str(variant_price),
            "delta": str(delta),
        })

    return findings


def all_products_with_variants():
    page = 1
    while True:
        payload = bc_get("/catalog/products", {
            "include": "variants",
            "limit": 250,
            "page": page,
        })
        for product in payload.get("data", []):
            yield product
        pagination = payload.get("meta", {}).get("pagination", {})
        total_pages = pagination.get("total_pages", page)
        if page >= total_pages:
            return
        page += 1


def build_report():
    rows = []
    for product in all_products_with_variants():
        variants = product.get("variants", [])
        for finding in find_stale_variant_overrides(product, variants):
            rows.append({
                "product_id": product.get("id"),
                "product_name": product.get("name"),
                "product_price": finding["product_price"],
                "variant_id": finding["variant_id"],
                "variant_sku": finding["sku"],
                "variant_price": finding["variant_price"],
                "delta": finding["delta"],
            })
    return rows


def write_report_json(rows, path="stale_variant_overrides.json"):
    with open(path, "w") as f:
        json.dump(rows, f, indent=2)
    log.info("Wrote %d row(s) to %s", len(rows), path)


def write_report_csv(rows, path="stale_variant_overrides.csv"):
    fieldnames = ["product_id", "product_name", "product_price", "variant_id", "variant_sku", "variant_price", "delta"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    log.info("Wrote %d row(s) to %s", len(rows), path)


def reset_variant_price(product_id, variant_id, also_clear_sale_price=False):
    """Clear a single, merchant-confirmed variant back to inheriting the
    product's price. Never call this in bulk. DRY_RUN gates the real write."""
    body = {"price": None}
    if also_clear_sale_price:
        body["sale_price"] = None

    if DRY_RUN:
        log.info(
            "DRY_RUN: would PUT /catalog/products/%s/variants/%s with %s",
            product_id, variant_id, body,
        )
        return None

    log.info("Resetting variant %s on product %s: %s", variant_id, product_id, body)
    return bc_put(f"/catalog/products/{product_id}/variants/{variant_id}", body)


def run(confirmed_variant_ids=None):
    """confirmed_variant_ids: an explicit set of variant ids a merchant has
    reviewed in the report and approved for reset. Defaults to none, which
    means this run only produces the report and writes nothing."""
    confirmed_variant_ids = set(confirmed_variant_ids or [])

    rows = build_report()
    write_report_json(rows)
    write_report_csv(rows)

    reset_count = 0
    for row in rows:
        variant_id = row["variant_id"]
        if variant_id not in confirmed_variant_ids:
            continue
        reset_variant_price(row["product_id"], variant_id)
        reset_count += 1

    log.info(
        "Done. %d divergent variant(s) reported, %d variant(s) %s.",
        len(rows), reset_count, "would be reset" if DRY_RUN else "reset",
    )


if __name__ == "__main__":
    confirmed = [int(v) for v in sys.argv[1:] if v.strip().isdigit()]
    run(confirmed_variant_ids=confirmed)
