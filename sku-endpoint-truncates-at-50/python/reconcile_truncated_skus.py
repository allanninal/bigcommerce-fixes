"""Find and re-fetch BigCommerce SKU / variant lists truncated at 50 records.

GET /v2/products/{id}/skus and its V3 successor GET /v3/catalog/products/{id}/
variants are paginated collection endpoints. When the limit query parameter is
omitted, BigCommerce silently defaults it to 50 per page, with a documented
maximum of 250. A client that calls the endpoint once, without limit/page and
without reading meta.pagination.total_pages, only ever sees the first 50 SKUs
or variants for any product that has more, and the response never signals
anything was cut off. This is a well known integration pitfall documented in
BigCommerce's own SDK issue trackers, not a platform bug. This job pages
through the full product catalog, probes each product's variants with the
exact unpaginated call a naive integration would make, flags every product_id
where records_fetched == 50 and meta.pagination.total > 50 (the truncation
signature), and re-fetches the complete, fully paginated list for each one it
flags. It never deletes or rewrites a SKU record; it only corrects the read.

Guide: https://www.allanninal.dev/bigcommerce/sku-endpoint-truncates-at-50/
"""
import os
import logging
from dataclasses import dataclass
from typing import Optional

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_truncated_skus")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

IMPLICIT_DEFAULT_LIMIT = 50
PAGE_LIMIT = 250

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    body = r.json() if r.text else {}
    return body.get("data", []), body.get("meta", {})


def is_truncated(
    records_fetched: int, page_limit_requested: Optional[int], meta_pagination_total: int
) -> bool:
    """Pure decision. No network, no side effects.

    If page_limit_requested is None, BigCommerce applied the implicit default
    of 50, so the call is truncated when records_fetched == 50 and the true
    total is greater than 50. If page_limit_requested is not None, truncation
    means records_fetched is less than the smaller of the requested limit and
    the true total, after exhausting every page implied by that total.
    """
    if page_limit_requested is None:
        return records_fetched == IMPLICIT_DEFAULT_LIMIT and meta_pagination_total > IMPLICIT_DEFAULT_LIMIT
    expected = min(page_limit_requested, meta_pagination_total)
    return records_fetched < expected


@dataclass
class ReconciliationRow:
    product_id: int
    expected_total: int
    records_fetched_without_pagination: int
    records_fetched_after_repair: int


def all_product_ids():
    page = 1
    while True:
        products, meta = bc_get("/catalog/products", {"limit": PAGE_LIMIT, "page": page})
        if not products:
            return
        for product in products:
            yield product["id"]
        pagination = meta.get("pagination", {})
        if page >= pagination.get("total_pages", page):
            return
        page += 1


def probe_variants_unpaginated(product_id):
    """The exact call a naive integration makes: no limit, no page."""
    records, meta = bc_get(f"/catalog/products/{product_id}/variants")
    total = meta.get("pagination", {}).get("total", len(records))
    return len(records), total


def fetch_all_variants(product_id):
    """Fully paginated. Always returns the complete list, never truncated."""
    all_records = []
    page = 1
    while True:
        records, meta = bc_get(
            f"/catalog/products/{product_id}/variants", {"limit": PAGE_LIMIT, "page": page}
        )
        all_records.extend(records)
        pagination = meta.get("pagination", {})
        if not records or page >= pagination.get("total_pages", page):
            return all_records
        page += 1


def run():
    affected: list[ReconciliationRow] = []
    scanned = 0

    for product_id in all_product_ids():
        scanned += 1
        records_fetched, expected_total = probe_variants_unpaginated(product_id)

        if not is_truncated(records_fetched, None, expected_total):
            continue

        log.warning(
            "product_id=%s truncated: records_fetched_without_pagination=%s expected_total=%s",
            product_id, records_fetched, expected_total,
        )

        corrected = fetch_all_variants(product_id)
        affected.append(
            ReconciliationRow(
                product_id=product_id,
                expected_total=expected_total,
                records_fetched_without_pagination=records_fetched,
                records_fetched_after_repair=len(corrected),
            )
        )

        if not DRY_RUN:
            # Re-sync only this product_id's mirrored SKU rows here, using `corrected`.
            log.info("product_id=%s re-synced with %s records.", product_id, len(corrected))
        else:
            log.info(
                "product_id=%s would re-sync %s records (DRY_RUN=true, no write performed).",
                product_id, len(corrected),
            )

    log.info(
        "Done. Scanned %d product(s). %d product(s) were truncated at the implicit 50-record default.",
        scanned, len(affected),
    )
    for row in affected:
        log.info(
            "REPORT product_id=%s expected_total=%s records_fetched_without_pagination=%s "
            "records_fetched_after_repair=%s",
            row.product_id, row.expected_total,
            row.records_fetched_without_pagination, row.records_fetched_after_repair,
        )


if __name__ == "__main__":
    run()
