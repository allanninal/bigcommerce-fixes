"""Serialize BigCommerce price list bulk upserts so concurrent jobs stop losing batches to 429.

BigCommerce serializes writes to Price List records at the store level. The bulk
upsert endpoint, PUT /v3/pricelists/{price_list_id}/records, allows only one
in-flight bulk upsert job per store at a time, regardless of which price list is
targeted. When multiple jobs, cron tasks, or app instances submit bulk PUT batches
concurrently, the platform's price-list processing lock rejects every overlapping
request with HTTP 429, and unlike a partial-batch validation error, the entire
batch is dropped rather than partially applied. This script acquires a per-store
lock before every bulk PUT, queues competing jobs instead of racing them, and on a
429 backs off with jitter and resubmits the identical batch, which is safe because
the endpoint upserts on variant_id or sku plus price_list_id and currency. Run one
instance per store. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/concurrent-price-list-upserts-429/
"""
import os
import time
import random
import logging
import threading

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("serialize_price_list_upserts")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "6"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

# In-process serialization for a single-host scheduler. For multiple hosts or
# processes, swap this for a Redis lock, e.g. SETNX pricelist:{store_hash}:bulk_lock
# with a TTL, released only after the PUT call returns a non-429 status.
_STORE_BULK_LOCK = threading.Lock()


def decide_retry(status_code: int, attempt: int, headers: dict, max_attempts: int = 6) -> dict:
    """Pure decision logic (no I/O) for handling a price-list bulk-upsert response.

    Args:
        status_code: HTTP status returned by PUT /v3/pricelists/{id}/records
        attempt: 1-based count of attempts made so far for this batch
        headers: response headers dict, may contain 'Retry-After' or
                 'X-Rate-Limit-Time-Reset-Ms'
        max_attempts: cap on retry attempts before giving up

    Returns:
        {"action": "success"} |
        {"action": "retry", "wait_ms": int, "reason": "concurrent_bulk_lock"} |
        {"action": "give_up", "reason": str}

    Logic:
      - status 200/201/207 -> success (batch accepted/upserted)
      - status 429 and attempt < max_attempts ->
            wait_ms computed from X-Rate-Limit-Time-Reset-Ms, else Retry-After,
            else capped exponential backoff (base 2s, cap 60s), with jitter.
            action retry with that wait_ms, reason "concurrent_bulk_lock"
      - status 429 and attempt >= max_attempts -> give_up, reason "max_attempts_exceeded"
      - status 4xx (not 429) -> give_up, reason "client_error_non_retryable"
      - status 5xx -> retry (transient) up to max_attempts, else give_up "server_error_max_attempts"
    """
    if status_code in (200, 201, 207):
        return {"action": "success"}

    if status_code == 429:
        if attempt >= max_attempts:
            return {"action": "give_up", "reason": "max_attempts_exceeded"}
        return {
            "action": "retry",
            "wait_ms": _compute_wait_ms(attempt, headers),
            "reason": "concurrent_bulk_lock",
        }

    if 500 <= status_code < 600:
        if attempt >= max_attempts:
            return {"action": "give_up", "reason": "server_error_max_attempts"}
        return {
            "action": "retry",
            "wait_ms": _compute_wait_ms(attempt, headers),
            "reason": "server_error",
        }

    return {"action": "give_up", "reason": "client_error_non_retryable"}


def _compute_wait_ms(attempt, headers):
    headers = headers or {}
    reset_ms = headers.get("X-Rate-Limit-Time-Reset-Ms")
    if reset_ms is not None:
        try:
            return int(reset_ms)
        except (TypeError, ValueError):
            pass
    retry_after = headers.get("Retry-After")
    if retry_after is not None:
        try:
            return int(float(retry_after) * 1000)
        except (TypeError, ValueError):
            pass
    base = min(60000, 2000 * (2 ** (attempt - 1)))
    jitter = random.randint(0, 250)
    return base + jitter


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put_records(price_list_id, records):
    r = requests.put(
        f"{API_BASE}/pricelists/{price_list_id}/records",
        headers=HEADERS,
        json=records,
        timeout=60,
    )
    body = r.json() if r.text else {}
    return r.status_code, dict(r.headers), body


def all_price_lists():
    """Page through every price list in the store via meta.pagination."""
    page = 1
    while True:
        payload = bc_get("/pricelists", {"limit": 250, "page": page})
        data = payload.get("data") or []
        if not data:
            return
        for price_list in data:
            yield price_list
        pagination = (payload.get("meta") or {}).get("pagination") or {}
        if page >= (pagination.get("total_pages") or page):
            return
        page += 1


def submit_batch_with_retry(price_list_id, records, max_attempts=MAX_ATTEMPTS, dry_run=DRY_RUN):
    """Submit one bulk upsert batch, retrying on 429/5xx per decide_retry."""
    attempt = 1
    while True:
        if dry_run:
            log.info(
                "DRY RUN: would submit batch price_list_id=%s records=%d attempt=%d",
                price_list_id, len(records), attempt,
            )
            return {"action": "success", "dry_run": True, "attempt": attempt}

        status_code, headers, body = bc_put_records(price_list_id, records)
        decision = decide_retry(status_code, attempt, headers, max_attempts)

        if decision["action"] == "success":
            log.info(
                "price_list_id=%s records=%d upserted on attempt %d",
                price_list_id, len(records), attempt,
            )
            return {"action": "success", "attempt": attempt, "body": body}

        if decision["action"] == "give_up":
            log.error(
                "price_list_id=%s gave up after attempt %d: %s",
                price_list_id, attempt, decision["reason"],
            )
            return decision

        log.warning(
            "price_list_id=%s got %s on attempt %d, retrying in %dms (%s)",
            price_list_id, status_code, attempt, decision["wait_ms"], decision["reason"],
        )
        time.sleep(decision["wait_ms"] / 1000)
        attempt += 1


def run_job(price_list_id, records):
    """Acquire the per-store lock, submit with retry, release the lock.

    Under DRY_RUN, no real lock is acquired; only the planned submission and
    queue wait are logged.
    """
    if DRY_RUN:
        log.info(
            "DRY RUN: job for price_list_id=%s queued, would wait for store lock",
            price_list_id,
        )
        return submit_batch_with_retry(price_list_id, records)

    with _STORE_BULK_LOCK:
        return submit_batch_with_retry(price_list_id, records)


def run(jobs):
    """jobs: iterable of (price_list_id, records) tuples to submit, one at a time."""
    results = []
    for price_list_id, records in jobs:
        results.append(run_job(price_list_id, records))
    succeeded = sum(1 for r in results if r["action"] == "success")
    log.info("Done. %d/%d job(s) succeeded.", succeeded, len(results))
    return results


if __name__ == "__main__":
    example_jobs = [
        (price_list["id"], [])
        for price_list in all_price_lists()
    ]
    run(example_jobs)
