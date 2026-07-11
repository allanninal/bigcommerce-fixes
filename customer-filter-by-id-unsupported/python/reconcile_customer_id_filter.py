"""Reconcile BigCommerce customer lookups that were rejected by the v2 id filter.

BigCommerce's v2 Customers resource (GET /v2/customers) only accepts a fixed,
documented set of filter query params, email, name, company, date_created, and
so on. The id field was never implemented as a filterable field on that legacy
list endpoint, unlike the v3 Customers API, which supports the id:in=1,2,3
filter syntax natively. Scripts and SDKs that assume v3-style filter
conventions work uniformly across versions pass ?id=123 to v2 and get a 400,
"The field 'id' is not supported by this resource.", because v2's query-string
filter whitelist simply omits id. The only supported way to fetch a single
customer on v2 is the direct resource path GET /v2/customers/{id}.

This is a client-side query-shape bug, not corrupt store data, so there is
nothing on the BigCommerce side to write or repair. This job attempts the v2
id filter, and on the specific 400 it reconciles a single id through the
direct resource path, or signals a migration to the v3 batched id:in filter
for multiple ids. Safe to run again and again, read-only by default.

Guide: https://www.allanninal.dev/bigcommerce/customer-filter-by-id-unsupported/
"""
import os
import re
import logging
from typing import Literal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_customer_id_filter")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_ROOT = f"https://api.bigcommerce.com/stores/{STORE_HASH}"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FIELD_NOT_SUPPORTED = re.compile(r"field '(\w+)' is not supported", re.IGNORECASE)

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_ROOT}{path}", headers=HEADERS, params=params or {}, timeout=30)
    body = r.json() if r.text else {}
    return r.status_code, body


def resolve_customer_lookup(
    filter_query: dict, api_version: str, response_status: int, error_field: str | None
) -> Literal["ok_list_filter", "fallback_direct_resource", "migrate_to_v3"]:
    """Pure decision. No network, no side effects.

    if api_version == "v3": always ok_list_filter, id:in is supported there.
    if api_version == "v2" and response_status == 400 and error_field == "id":
        fallback_direct_resource when a single id was requested, since the
        direct resource path only fetches one customer at a time, otherwise
        migrate_to_v3 when multiple ids were requested.
    otherwise: ok_list_filter (the call already succeeded, or failed for an
    unrelated reason that this reconciler does not handle).
    """
    if api_version == "v3":
        return "ok_list_filter"

    if api_version == "v2" and response_status == 400 and error_field == "id":
        requested_ids = filter_query.get("id")
        id_count = len(str(requested_ids).split(",")) if requested_ids else 0
        if id_count <= 1:
            return "fallback_direct_resource"
        return "migrate_to_v3"

    return "ok_list_filter"


def try_v2_id_filter(ids):
    query = {"id": ",".join(str(i) for i in ids)}
    status, body = bc_get("/v2/customers", query)
    error_field = None
    if status == 400:
        match = FIELD_NOT_SUPPORTED.search(body.get("error", ""))
        if match:
            error_field = match.group(1)
    return query, status, error_field


def fetch_customer_direct(customer_id):
    return bc_get(f"/v2/customers/{customer_id}")


def fetch_customers_v3(ids):
    return bc_get("/v3/customers", {"id:in": ",".join(str(i) for i in ids)})


def run(id_batches=None):
    """id_batches: list of lists of customer ids to reconcile, e.g. [[123], [45, 46, 47]]."""
    id_batches = id_batches if id_batches is not None else [[123]]

    reconciled = 0
    migrated = 0

    for ids in id_batches:
        query, status, error_field = try_v2_id_filter(ids)
        decision = resolve_customer_lookup(query, "v2", status, error_field)

        if decision == "ok_list_filter":
            log.info("ids=%s v2 list filter succeeded, no reconciliation needed", ids)
            continue

        if decision == "fallback_direct_resource":
            log.info(
                "ids=%s v2 id filter rejected (%s), %s direct resource path GET /v2/customers/%s",
                ids, error_field, "would call" if DRY_RUN else "calling", ids[0],
            )
            if not DRY_RUN:
                direct_status, direct_body = fetch_customer_direct(ids[0])
                log.info("direct resource path returned status=%s", direct_status)
            reconciled += 1
            continue

        if decision == "migrate_to_v3":
            log.info(
                "ids=%s v2 id filter rejected (%s), %s v3 batched filter GET /v3/customers?id:in=%s",
                ids, error_field, "would call" if DRY_RUN else "calling", ",".join(str(i) for i in ids),
            )
            if not DRY_RUN:
                v3_status, v3_body = fetch_customers_v3(ids)
                log.info("v3 batched filter returned status=%s", v3_status)
            migrated += 1

    log.info(
        "Done. %d batch(es) %s via direct resource path, %d batch(es) %s via v3 id:in.",
        reconciled, "to reconcile" if DRY_RUN else "reconciled",
        migrated, "to migrate" if DRY_RUN else "migrated",
    )


if __name__ == "__main__":
    run()
