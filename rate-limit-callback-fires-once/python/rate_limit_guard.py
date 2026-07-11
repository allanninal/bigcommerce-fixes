"""Read BigCommerce's live rate limit headers on every request instead of a one-shot callback.

BigCommerce enforces a sliding request quota per store (default 150 requests per
30,000 ms window for OAuth apps) and reports the live state on every response
through X-Rate-Limit-Requests-Left, X-Rate-Limit-Requests-Quota,
X-Rate-Limit-Time-Window-Ms, and X-Rate-Limit-Time-Reset-Ms. There is no
server-side webhook or push callback for rate limiting, it is purely response
header driven. Client libraries such as bigcommerce-api-python wire a
callback_function into the client once, at construction time, and their
internal "requests remaining" counter is only updated inside their own request
loop rather than re-read from the live headers on every call, so the callback
fires a single time instead of on every request that crosses the threshold.
The script then free runs on stale internal state and keeps colliding with the
real quota, hitting repeated 429 Too Many Requests responses.

This helper reads the four headers off every response and decides, fresh each
time, whether to sleep before the next call. If DRY_RUN=true it only replays a
log of historical responses and prints the computed sleep durations without
making live calls. If DRY_RUN=false it applies the throttling in the live
request loop.

Guide: https://www.allanninal.dev/bigcommerce/rate-limit-callback-fires-once/
"""
import os
import time
import logging
from typing import Optional, Tuple

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rate_limit_guard")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MIN_REQUESTS_REMAINING = int(os.environ.get("MIN_REQUESTS_REMAINING", "10"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def should_throttle(
    requests_left: Optional[int],
    time_reset_ms: Optional[int],
    min_requests_remaining: int = MIN_REQUESTS_REMAINING,
    status_code: int = 200,
) -> Tuple[bool, int]:
    """Pure decision. No network, no side effects.

    Returns (True, time_reset_ms) if status_code == 429 or requests_left is
    missing/negative/<= min_requests_remaining, meaning the caller must sleep
    time_reset_ms before its next request. Otherwise returns (False, 0).
    Missing or invalid header values fail safe toward throttling.
    """
    safe_reset_ms = time_reset_ms if isinstance(time_reset_ms, int) and time_reset_ms > 0 else 0

    if status_code == 429:
        return True, safe_reset_ms

    if requests_left is None or requests_left <= min_requests_remaining:
        return True, safe_reset_ms

    return False, 0


def _parse_rate_headers(response) -> dict:
    def _int_or_none(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return {
        "requests_left": _int_or_none(response.headers.get("X-Rate-Limit-Requests-Left")),
        "requests_quota": _int_or_none(response.headers.get("X-Rate-Limit-Requests-Quota")),
        "window_ms": _int_or_none(response.headers.get("X-Rate-Limit-Time-Window-Ms")) or 0,
        "reset_ms": _int_or_none(response.headers.get("X-Rate-Limit-Time-Reset-Ms")) or 0,
        "status_code": response.status_code,
    }


def bc_get(path, params=None):
    response = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    rate = _parse_rate_headers(response)
    return response, rate


def replay_dry_run(historical_responses):
    """Simulate throttle decisions against a replayed log, no live calls."""
    for entry in historical_responses:
        throttle, wait_ms = should_throttle(
            entry.get("requests_left"),
            entry.get("reset_ms", 0),
            MIN_REQUESTS_REMAINING,
            entry.get("status_code", 200),
        )
        log.info(
            "timestamp=%s requests_left=%s reset_ms=%s status_code=%s throttle=%s wait_ms=%s",
            entry.get("timestamp"), entry.get("requests_left"), entry.get("reset_ms"),
            entry.get("status_code", 200), throttle, wait_ms if throttle else 0,
        )


def run(paths=None):
    paths = paths or ["/catalog/products"]

    if DRY_RUN:
        log.info("DRY_RUN=true, replaying without live calls is expected; pass a historical log to replay_dry_run().")
        return

    for path in paths:
        response, rate = bc_get(path)
        throttle, wait_ms = should_throttle(
            rate["requests_left"], rate["reset_ms"], MIN_REQUESTS_REMAINING, rate["status_code"]
        )
        log.info(
            "path=%s status_code=%s requests_left=%s reset_ms=%s throttle=%s",
            path, rate["status_code"], rate["requests_left"], rate["reset_ms"], throttle,
        )
        if throttle and wait_ms > 0:
            time.sleep(wait_ms / 1000)


if __name__ == "__main__":
    run()
