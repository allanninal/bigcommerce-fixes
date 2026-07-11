"""Reconcile a BigCommerce order count mismatch between /v2/orders/count and /v2/orders.

GET /v2/orders/count and GET /v2/orders both accept status_id, min_date_created,
max_date_created, and customer_id, and both apply an implicit default scope when
status_id is omitted. Incomplete orders (status_id 0, abandoned at payment) are
commonly excluded from an unfiltered count's default scope but still appear in an
unfiltered pagination scan, so a script calling one endpoint with no filters and
the other with a different filter set ends up comparing two different result
sets. A secondary cause is timing: count is a point-in-time snapshot, while a
multi-page scan can take seconds to minutes on a large store. This job sums
per-status counts across all 15 status_id values, fully paginates the order list
with the same filters, reconciles the two totals bucket by bucket, and re-checks
the count snapshot after pagination to rule out concurrency drift. It only ever
reports. It never deletes or modifies an order based on a count mismatch alone.

Guide: https://www.allanninal.dev/bigcommerce/order-count-endpoint-mismatch/
"""
import os
import logging
from collections import Counter
from dataclasses import dataclass

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_order_counts")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
MIN_DATE_CREATED = os.environ.get("MIN_DATE_CREATED") or None
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ALL_STATUS_IDS = list(range(15))  # 0 Incomplete .. 14 Partially Refunded
PAGE_LIMIT = 250

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


@dataclass
class ReconciliationReport:
    total_count_endpoint: int
    total_paginated: int
    per_status_deltas: dict
    mismatched_status_ids: list
    is_consistent: bool


def reconcile_order_counts(count_endpoint_totals: dict, paginated_order_status_ids: list) -> ReconciliationReport:
    """Pure comparison. No network, no side effects.

    count_endpoint_totals maps status_id -> count returned by
    GET /v2/orders/count?status_id={id} for each of the 15 status_id values.
    paginated_order_status_ids is the flat list of status_id values collected by
    fully paginating GET /v2/orders with the same filters. Returns a plain report
    with the two grand totals, a per-status delta map, the list of status_id
    values where the two disagree, and whether every bucket balances.
    """
    paginated_counts = Counter(paginated_order_status_ids)
    all_status_ids = set(count_endpoint_totals) | set(paginated_counts)

    per_status_deltas = {}
    for status_id in all_status_ids:
        expected = count_endpoint_totals.get(status_id, 0)
        actual = paginated_counts.get(status_id, 0)
        per_status_deltas[status_id] = expected - actual

    mismatched_status_ids = sorted(sid for sid, delta in per_status_deltas.items() if delta != 0)

    return ReconciliationReport(
        total_count_endpoint=sum(count_endpoint_totals.values()),
        total_paginated=len(paginated_order_status_ids),
        per_status_deltas=per_status_deltas,
        mismatched_status_ids=mismatched_status_ids,
        is_consistent=all(delta == 0 for delta in per_status_deltas.values()),
    )


def count_by_status():
    totals = {}
    for status_id in ALL_STATUS_IDS:
        params = {"status_id": status_id}
        if MIN_DATE_CREATED:
            params["min_date_created"] = MIN_DATE_CREATED
        body = bc_get("/orders/count", params)
        totals[status_id] = body.get("count", 0)
    return totals


def paginate_all_order_status_ids():
    status_ids = []
    page = 1
    while True:
        params = {"page": page, "limit": PAGE_LIMIT, "sort": "id:asc"}
        if MIN_DATE_CREATED:
            params["min_date_created"] = MIN_DATE_CREATED
        orders = bc_get("/orders", params)
        if not orders:
            return status_ids
        for order in orders:
            status_ids.append(order["status_id"])
        if len(orders) < PAGE_LIMIT:
            return status_ids
        page += 1


def log_report(label, report):
    log.info("[%s] unfiltered_count=%s paginated_total=%s is_consistent=%s",
              label, report.total_count_endpoint, report.total_paginated, report.is_consistent)
    if not report.is_consistent:
        for status_id in report.mismatched_status_ids:
            log.warning("[%s] status_id=%s delta=%s", label, status_id, report.per_status_deltas[status_id])


def run():
    log.info("Fetching per-status counts before pagination (DRY_RUN=%s, report only, no writes).", DRY_RUN)
    counts_before = count_by_status()

    paginated_status_ids = paginate_all_order_status_ids()

    log.info("Fetching per-status counts again after pagination to check for concurrency drift.")
    counts_after = count_by_status()

    report_before = reconcile_order_counts(counts_before, paginated_status_ids)
    report_after = reconcile_order_counts(counts_after, paginated_status_ids)

    log_report("pre-scan snapshot", report_before)
    log_report("post-scan snapshot", report_after)

    if report_before.is_consistent and report_after.is_consistent:
        log.info("Consistent. Counts and pagination agree across all status_id buckets.")
        return

    if not report_before.is_consistent and report_after.is_consistent:
        log.info("Mismatch resolved by the post-scan snapshot. Likely concurrency drift during the scan window.")
        return

    log.warning(
        "Persistent mismatch after re-checking the count snapshot. mismatched_status_ids=%s. "
        "This is a report for a human, escalate to BigCommerce support with store_hash=%s, "
        "min_date_created=%s, and the mismatched status_id list. No orders were modified.",
        report_after.mismatched_status_ids, STORE_HASH, MIN_DATE_CREATED,
    )


if __name__ == "__main__":
    run()
