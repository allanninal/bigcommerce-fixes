"""Find duplicate and missing SKUs across a BigCommerce catalog, and flag them.

BigCommerce only validates SKU uniqueness at write time, on a POST or PUT to
/v3/catalog/products or its /variants sub-resource, which returns a 422 if the
value collides with an existing one. It never retroactively scans the catalog,
so duplicates and blanks that entered through CSV bulk imports, multi-channel or
POS/ERP sync tools, or the Admin's Duplicate product action persist undetected.
Blank SKUs are common because the sku field is optional on creation.

This pages through GET /v3/catalog/products?include=variants&limit=250 across
the full catalog, flattens each product and its variants into SKU records,
classifies them with a pure function, and in write mode appends a custom_fields
marker to each conflicting product or variant so a merchandiser can hand-correct
the real value. It never rewrites a SKU itself. Guarded by DRY_RUN. Safe to run
again and again.

Guide: https://www.allanninal.dev/bigcommerce/duplicate-or-missing-skus/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_sku_conflicts")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    if not r.content:
        return None
    body = r.json()
    return body["data"] if isinstance(body, dict) and "data" in body else body


def classify_sku_conflicts(records):
    """records: [{"id", "parentProductId", "sku"}] -> {"duplicates", "missing"}. Pure, no I/O.

    Normalizes each sku with trim() and lower-casing, treating null, undefined, or
    whitespace-only as missing rather than a joinable key. Groups the rest by the
    normalized value and reports every group with more than one record id as a
    duplicate. Output is sorted for deterministic, testable ordering.
    """
    groups = {}
    missing = []
    for record in records:
        sku = record.get("sku")
        normalized = sku.strip().lower() if isinstance(sku, str) else ""
        if not normalized:
            missing.append({"id": record["id"], "parentProductId": record.get("parentProductId")})
            continue
        groups.setdefault(normalized, []).append(record["id"])

    duplicates = [
        {"normalizedSku": sku, "recordIds": ids}
        for sku, ids in groups.items()
        if len(ids) > 1
    ]
    duplicates.sort(key=lambda d: d["normalizedSku"])
    missing.sort(key=lambda m: m["id"])
    return {"duplicates": duplicates, "missing": missing}


def all_products():
    """Yield every product with its variants, paginated."""
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v3/catalog/products?include=variants&limit={limit}&page={page}")
        if not batch:
            return
        for product in batch:
            yield product
        if len(batch) < limit:
            return
        page += 1


def sku_records(product):
    """Flatten a product into SKU records: the product's own SKU plus each variant's."""
    records = [{"id": product["id"], "parentProductId": None, "sku": product.get("sku")}]
    for variant in product.get("variants") or []:
        records.append({"id": variant["id"], "parentProductId": product["id"], "sku": variant.get("sku")})
    return records


def flag_product(product_id, marker_value):
    return bc("PUT", f"/v3/catalog/products/{product_id}",
              json={"custom_fields": [{"name": "sku_conflict", "value": marker_value}]})


def flag_variant(product_id, variant_id, marker_value):
    return bc("PUT", f"/v3/catalog/products/{product_id}/variants/{variant_id}",
              json={"custom_fields": [{"name": "sku_conflict", "value": marker_value}]})


def run():
    all_records = []
    for product in all_products():
        all_records.extend(sku_records(product))

    result = classify_sku_conflicts(all_records)
    duplicates = result["duplicates"]
    missing = result["missing"]

    for dup in duplicates:
        ids = ",".join(str(i) for i in dup["recordIds"])
        marker = f"duplicate:{dup['normalizedSku']}|ids:{ids}"
        log.warning("Duplicate SKU %r across ids %s. %s",
                     dup["normalizedSku"], ids, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            for record_id in dup["recordIds"]:
                flag_product(record_id, marker)

    for miss in missing:
        log.warning("Missing SKU on id %s (parentProductId=%s). %s",
                     miss["id"], miss["parentProductId"], "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            if miss["parentProductId"] is None:
                flag_product(miss["id"], "missing_sku")
            else:
                flag_variant(miss["parentProductId"], miss["id"], "missing_sku")

    log.info(
        "Done. %d duplicate group(s) and %d missing SKU(s) %s.",
        len(duplicates), len(missing), "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
