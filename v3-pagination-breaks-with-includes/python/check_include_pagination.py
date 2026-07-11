"""Detect BigCommerce v3 catalog/products pagination truncation with include.

BigCommerce's v3 catalog/products endpoint documents that when include=options,
include=modifiers, or include=variants is requested, the server silently caps the
page size at 10 records per page regardless of the limit query param sent, because
hydrating those nested sub-resources per product is expensive to join and
serialize. meta.pagination.total is still computed correctly, but total_pages is
calculated from the same count query used for the plain, un-hydrated list, so it
understates how many 10-record pages are actually needed. A client that walks
pages until page > meta.pagination.total_pages stops early and silently drops
products from the tail of the catalog.

This script never writes anything. It pulls a baseline list (no include) and a
suspect list (include=options,modifiers), reconciles the product id sets with a
pure function, and logs which product ids the include pull would have missed if
total_pages had been trusted as the stop condition. Safe to run again and again
against a live store.

Guide: https://www.allanninal.dev/bigcommerce/v3-pagination-breaks-with-includes/
"""
import os
import math
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_include_pagination")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

INCLUDE_PARAM = os.environ.get("INCLUDE_PARAM", "options,modifiers")
LIMIT = int(os.environ.get("LIMIT", "250"))
SAMPLE_SIZE = int(os.environ.get("SAMPLE_SIZE", "10"))

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def pull_baseline(limit=LIMIT):
    """Walk the un-hydrated list, where total_pages is trustworthy."""
    page = 1
    ids = []
    total = None
    while True:
        resp = bc_get("/catalog/products", {"limit": limit, "page": page})
        pagination = resp["meta"]["pagination"]
        total = pagination["total"]
        ids.extend(str(p["id"]) for p in resp["data"])
        if page >= pagination["total_pages"]:
            break
        page += 1
    return ids, total


def pull_with_include(include=INCLUDE_PARAM, limit=LIMIT):
    """Walk the hydrated list using the authoritative empty-data-array signal."""
    page = 1
    pages = []
    while True:
        resp = bc_get("/catalog/products", {"limit": limit, "page": page, "include": include})
        pages.append(resp)
        if not resp["data"]:
            break
        page += 1
    return pages


def reconcile_paginated_product_ids(baseline_ids, include_pull_pages):
    """Pure decision. No network, no side effects.

    Flattens include_pull_pages[].data[].id into a set, computes missingIds as the
    baseline ids not present in that set, computes the number of 10-record pages
    actually needed against the include pull's own per_page, and compares that
    against the include pull's own reported total_pages. paginationTrustworthy is
    true only when total_pages covers the pages actually needed AND no ids are
    missing. recommendedStopCondition is "total_pages" when trustworthy, otherwise
    "empty_data_array", which is what a caller should switch to.
    """
    include_ids = set()
    for page in include_pull_pages:
        for item in page["data"]:
            include_ids.add(str(item["id"]))

    missing_ids = [pid for pid in baseline_ids if pid not in include_ids]

    per_page = include_pull_pages[0]["meta"]["pagination"]["per_page"]
    implied_full_pages = math.ceil(len(baseline_ids) / per_page) if per_page else 0
    reported_total_pages = include_pull_pages[0]["meta"]["pagination"]["total_pages"]

    pagination_trustworthy = (
        reported_total_pages >= implied_full_pages and len(missing_ids) == 0
    )

    return {
        "missingIds": missing_ids,
        "paginationTrustworthy": pagination_trustworthy,
        "recommendedStopCondition": "total_pages" if pagination_trustworthy else "empty_data_array",
    }


def run():
    baseline_ids, baseline_total = pull_baseline()
    include_pages = pull_with_include()

    result = reconcile_paginated_product_ids(baseline_ids, include_pages)

    if not result["missingIds"]:
        log.info(
            "store=%s baseline_total=%d pagination is trustworthy, total_pages is safe to use.",
            STORE_HASH, baseline_total,
        )
        return

    log.warning(
        "store=%s baseline_total=%d total_pages UNDERSTATES the real page count. "
        "missing=%d sample_ids=%s recommended_stop_condition=%s",
        STORE_HASH, baseline_total, len(result["missingIds"]),
        result["missingIds"][:SAMPLE_SIZE], result["recommendedStopCondition"],
    )
    if DRY_RUN:
        log.info(
            "DRY_RUN=true: report only. Client-side workaround: when include contains "
            "options or modifiers, ignore meta.pagination.total_pages and loop page += 1 "
            "until a response returns data: [] (empty array)."
        )


if __name__ == "__main__":
    run()
