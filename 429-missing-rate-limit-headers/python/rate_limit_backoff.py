"""Back off safely on BigCommerce 429s, even when rate limit headers are missing.

BigCommerce's REST API normally returns 429 Too Many Requests with four headers,
X-Rate-Limit-Time-Window-Ms, X-Rate-Limit-Time-Reset-Ms, X-Rate-Limit-Requests-Quota,
and X-Rate-Limit-Requests-Left, so a client can compute exactly how long to wait.
When the platform itself is under high load, excessive traffic across a store or a
shared infrastructure tier, the edge or proxy layer can throttle a request before it
reaches the per-token accounting logic that stamps those headers, so it returns a
bare 429 with none of them. Client code that expects the reset header and crashes or
retries immediately when it is missing makes the overload worse. This helper checks
every 429 for the four headers, uses the exact reset time when present, and falls
back to a capped exponential backoff with jitter when it is not. It also logs the
header-less occurrence (store hash, endpoint, timestamp) for monitoring. There is
nothing to write back to BigCommerce here, this is a client-side guard, not a
store-data repair.

Guide: https://www.allanninal.dev/bigcommerce/429-missing-rate-limit-headers/
"""
import os
import time
import random
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rate_limit_backoff")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "5"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RATE_LIMIT_HEADERS = [
    "X-Rate-Limit-Time-Window-Ms",
    "X-Rate-Limit-Time-Reset-Ms",
    "X-Rate-Limit-Requests-Quota",
    "X-Rate-Limit-Requests-Left",
]
RESET_HEADER = "X-Rate-Limit-Time-Reset-Ms"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def compute_backoff_seconds(
    status_code: int,
    headers: dict,
    attempt: int,
    base_seconds: float = 1.0,
    max_seconds: float = 60.0,
    jitter_ratio: float = 0.2,
) -> float:
    """Pure decision. No I/O, no sleep call, no network access.

    if status_code != 429: return 0, no backoff needed.
    If X-Rate-Limit-Time-Reset-Ms is present (case-insensitive) and parses as a
    non-negative number, return that value divided by 1000 as exact seconds to wait.
    Otherwise fall back to min(base_seconds * 2**attempt, max_seconds) with
    +/- jitter_ratio random jitter applied.
    """
    if status_code != 429:
        return 0

    reset_ms = None
    for key, value in (headers or {}).items():
        if key.lower() == RESET_HEADER.lower():
            reset_ms = value
            break

    if reset_ms is not None:
        try:
            reset_ms_num = float(reset_ms)
            if reset_ms_num >= 0:
                return reset_ms_num / 1000.0
        except (TypeError, ValueError):
            pass

    wait = min(base_seconds * (2 ** attempt), max_seconds)
    jitter = wait * jitter_ratio
    return wait + random.uniform(-jitter, jitter)


def headers_present(headers) -> bool:
    keys = {str(k).lower() for k in (headers or {}).keys()}
    return all(h.lower() in keys for h in RATE_LIMIT_HEADERS)


def log_headerless_429(path, store_hash, timestamp):
    log.warning(
        "Header-less 429 detected. path=%s store_hash=%s at=%s",
        path, store_hash, timestamp,
    )


def bc_get(path, params=None):
    """Returns (status_code, headers, body). Never raises on 429."""
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    body = r.json() if r.text else {}
    return r.status_code, r.headers, body


def get_with_backoff(path, params=None, max_retries=MAX_RETRIES):
    status_code, headers, body = None, {}, {}
    for attempt in range(max_retries + 1):
        status_code, headers, body = bc_get(path, params)
        if status_code != 429:
            return status_code, headers, body

        if not headers_present(headers):
            log_headerless_429(path, STORE_HASH, time.time())
            if DRY_RUN:
                log.info("DRY_RUN: would back off and retry attempt=%d", attempt)
                return status_code, headers, body

        wait_seconds = compute_backoff_seconds(status_code, headers, attempt)
        log.info("429 on %s, waiting %.2fs before retry (attempt %d)", path, wait_seconds, attempt)
        if not DRY_RUN:
            time.sleep(wait_seconds)

    return status_code, headers, body


def run():
    status_code, headers, body = get_with_backoff("/catalog/products", {"limit": 1})
    log.info("Final status=%s headers_present=%s", status_code, headers_present(headers))


if __name__ == "__main__":
    run()
