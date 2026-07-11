"""Find BigCommerce price list variant coverage gaps.

BigCommerce price lists store overrides as flat per-variant records, each keyed
by variant_id and currency, not as product-level rules that cascade to child
variants. A CSV import, an admin UI edit, or an API batch upsert can easily
cover only some of a product's variants and miss newly added ones. Because the
pricing engine looks up a record for the exact variant_id being viewed and
falls through to standard catalog pricing when nothing matches, the gap is
silent: no admin warning, no validation error, no webhook. This job enumerates
every active variant storewide, pulls every record from every price list that
is actually assigned to a customer group, and reports every variant missing
from an active price list. It never guesses a price. It only reports, unless
a caller supplies an explicit fallback rule and DRY_RUN=false.

Guide: https://www.allanninal.dev/bigcommerce/price-list-missing-variant-entry/
"""
import os
import json
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("price_list_variant_gaps")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

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


def bc_get_all_pages(path, params=None):
    page = 1
    items = []
    while True:
        body = bc_get(path, {**(params or {}), "limit": 250, "page": page})
        items.extend(body.get("data", []))
        pagination = body.get("meta", {}).get("pagination", {})
        if page >= pagination.get("total_pages", 1):
            return items
        page += 1


def find_variant_price_gaps(active_variant_ids, price_list_records, group_to_price_list):
    """Pure decision. No network, no side effects.

    covered = variant_ids that already have a record in some price list.
    gaps = active_variant_ids not in covered.
    For every price_list_id referenced by group_to_price_list, emit one row
    per gap variant with the customer_group_ids that reference that list.
    Returns a list of dicts sorted by variant_id.
    """
    covered = {r["variant_id"] for r in price_list_records}
    gaps = active_variant_ids - covered

    results = []
    price_list_ids = set(group_to_price_list.values())
    for price_list_id in price_list_ids:
        affected_groups = [
            g for g, pl in group_to_price_list.items() if pl == price_list_id
        ]
        for variant_id in gaps:
            results.append({
                "price_list_id": price_list_id,
                "variant_id": variant_id,
                "affected_customer_groups": affected_groups,
            })
    return sorted(results, key=lambda r: r["variant_id"])


def active_variants():
    """Every variant belonging to a visible, purchasable product."""
    variants = bc_get_all_pages("/catalog/variants")
    visible_product_ids = {
        p["id"] for p in bc_get_all_pages(
            "/catalog/products", {"include_fields": "is_visible,availability"}
        )
        if p.get("is_visible")
    }
    return [v for v in variants if v["product_id"] in visible_product_ids]


def all_price_lists():
    return [pl for pl in bc_get_all_pages("/pricelists") if pl.get("active")]


def group_to_price_list(customer_group_ids):
    mapping = {}
    for group_id in customer_group_ids:
        assignments = bc_get_all_pages(
            "/pricelists/assignments", {"customer_group_id": group_id}
        )
        for a in assignments:
            if a.get("price_list_id"):
                mapping[group_id] = a["price_list_id"]
    return mapping


def price_list_records(price_list_id):
    return bc_get_all_pages(f"/pricelists/{price_list_id}/records")


def enrich_gaps(gaps, variants_by_id):
    enriched = []
    for gap in gaps:
        variant = variants_by_id.get(gap["variant_id"], {})
        enriched.append({
            **gap,
            "product_id": variant.get("product_id"),
            "sku": variant.get("sku"),
        })
    return enriched


def apply_fallback(price_list_id, records_to_write):
    """Only called when a caller supplies an explicit fallback rule.

    records_to_write: list of {variant_id, currency, price, sale_price, retail_price}.
    Up to 1000 records per call. Respect DRY_RUN.
    """
    batch_size = 1000
    for i in range(0, len(records_to_write), batch_size):
        batch = records_to_write[i:i + batch_size]
        log.info(
            "%s %d record(s) to price_list_id=%s",
            "Would write" if DRY_RUN else "Writing", len(batch), price_list_id,
        )
        if not DRY_RUN:
            bc_put(f"/pricelists/{price_list_id}/records/batch", batch)


def run(customer_group_ids=None, fallback_rule=None):
    customer_group_ids = customer_group_ids or []

    variants = active_variants()
    variants_by_id = {v["id"]: v for v in variants}
    active_ids = set(variants_by_id.keys())

    mapping = group_to_price_list(customer_group_ids)
    price_list_ids = set(mapping.values())

    all_records = []
    for price_list_id in price_list_ids:
        all_records.extend(price_list_records(price_list_id))

    gaps = find_variant_price_gaps(active_ids, all_records, mapping)
    enriched = enrich_gaps(gaps, variants_by_id)

    log.info("Found %d variant price gap(s) across %d price list(s).", len(enriched), len(price_list_ids))
    print(json.dumps(enriched, indent=2))

    if fallback_rule is not None:
        by_price_list = {}
        for gap in enriched:
            by_price_list.setdefault(gap["price_list_id"], []).append(gap)
        for price_list_id, gap_rows in by_price_list.items():
            records_to_write = [fallback_rule(row, variants_by_id) for row in gap_rows]
            apply_fallback(price_list_id, records_to_write)

    return enriched


if __name__ == "__main__":
    run()
