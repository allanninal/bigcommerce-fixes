"""Detect a silent no-op when POST /v3/customers/addresses matches a duplicate.

BigCommerce's V3 Customer Addresses endpoint treats first_name, last_name,
company, phone, address_type, address1, address2, city, country_code,
state_or_province, and postal_code as a uniqueness key per customer. When a
POST matches an existing address on all of these fields, BigCommerce makes no
change to the existing record and returns a 200 or 207 success, but the
address is omitted from the response body's data, so no new address id is
ever returned. An integration that assumes 200 means "created, id returned"
will misreport the operation and drift out of sync with the store's real
address list. This script snapshots a customer's addresses before the write,
posts the new address, snapshots again, and classifies the result with a pure
function. A confirmed silent no-op is flagged and reported with the matched
existing address id, never retried, since there is no bad state to repair.

Guide: https://www.allanninal.dev/bigcommerce/duplicate-address-create-silent-noop/
"""
import os
import logging
from typing import Literal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_address_noop")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

UNIQUENESS_FIELDS = [
    "first_name", "last_name", "company", "phone", "address_type",
    "address1", "address2", "city", "country_code", "state_or_province", "postal_code",
]

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return {"data": [], "meta": {"pagination": {"total": 0}}}
    return r.json()


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    return r.status_code, (r.json() if r.text else {})


def uniqueness_key(fields):
    return tuple((fields.get(f) or "").strip().lower() for f in UNIQUENESS_FIELDS)


def find_matched_address_id(existing_addresses, attempted_fields):
    target = uniqueness_key(attempted_fields)
    for addr in existing_addresses:
        if uniqueness_key(addr) == target:
            return addr["id"]
    return None


def snapshot_addresses(customer_id):
    """Page through GET /v3/customers/addresses for one customer.

    Returns {"ids": set(...), "total": int, "records": [...]} so callers can
    both diff by id/total and look up the matched record's full fields.
    """
    ids = set()
    records = []
    page = 1
    total = 0
    while True:
        body = bc_get(
            "/customers/addresses",
            {"customer_id:in": customer_id, "page": page, "limit": 250},
        )
        data = body.get("data") or []
        for addr in data:
            ids.add(addr["id"])
            records.append(addr)
        pagination = (body.get("meta") or {}).get("pagination") or {}
        total = pagination.get("total", len(ids))
        next_link = (pagination.get("links") or {}).get("next")
        if not data or not next_link:
            break
        page += 1
    return {"ids": ids, "total": total, "records": records}


def classify_address_create_result(
    pre_snapshot: dict, post_response: dict, post_snapshot: dict
) -> Literal["created", "silent_noop", "error"]:
    """Pure decision. No network, no side effects.

    if post_response["status"] >= 400: error.
    Else if the response has no address id in data, and the post-write
    snapshot's total and id set are unchanged from the pre-write snapshot,
    silent_noop. Otherwise a new id appeared, or data has an id: created.
    """
    status = post_response.get("status")
    if status is None or status >= 400:
        return "error"

    data = post_response.get("data")
    data_has_id = bool(data) and (
        (isinstance(data, dict) and data.get("id") is not None)
        or (
            isinstance(data, list)
            and len(data) > 0
            and any(isinstance(item, dict) and item.get("id") is not None for item in data)
        )
    )

    pre_ids = pre_snapshot.get("ids") or set()
    post_ids = post_snapshot.get("ids") or set()
    new_ids = post_ids - pre_ids

    total_unchanged = post_snapshot.get("total") == pre_snapshot.get("total")
    ids_unchanged = post_ids.issubset(pre_ids) and not new_ids

    if not data_has_id and total_unchanged and ids_unchanged:
        return "silent_noop"

    return "created"


def create_customer_address(address_fields):
    return bc_post("/customers/addresses", [address_fields])


def run(customer_id, address_fields):
    pre_snapshot = snapshot_addresses(customer_id)

    if DRY_RUN:
        log.info(
            "DRY_RUN: would POST address for customer_id=%s. Skipping write, "
            "pre_snapshot_total=%s",
            customer_id, pre_snapshot["total"],
        )
        return "dry_run"

    status, body = bc_post("/customers/addresses", [address_fields])
    post_response = {"status": status, "data": body.get("data")}

    post_snapshot = snapshot_addresses(customer_id)
    decision = classify_address_create_result(pre_snapshot, post_response, post_snapshot)

    if decision == "error":
        log.error(
            "Address create failed. customer_id=%s status=%s body=%s",
            customer_id, status, body,
        )
        return decision

    if decision == "silent_noop":
        matched_id = find_matched_address_id(pre_snapshot["records"], address_fields)
        log.warning(
            "address_create_silent_noop: exact duplicate already existed, no new "
            "address_id created. customer_id=%s matched_existing_address_id=%s "
            "attempted_fields=%s",
            customer_id, matched_id, address_fields,
        )
        return decision

    log.info("Address created for customer_id=%s. total now %s", customer_id, post_snapshot["total"])
    return decision


if __name__ == "__main__":
    run(
        customer_id=123,
        address_fields={
            "first_name": "Jamie",
            "last_name": "Rivera",
            "address1": "123 Main St",
            "city": "Austin",
            "country_code": "US",
            "state_or_province": "Texas",
            "postal_code": "78701",
        },
    )
