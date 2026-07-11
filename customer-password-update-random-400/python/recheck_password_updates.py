"""Tell a genuine BigCommerce password-update failure apart from a false 400.

PUT /v3/customers is a batch array endpoint, capped at 3 concurrent requests,
that validates authentication.new_password against the store's password
complexity and history rules server side without exposing those rules through
the same response. A 400 for one array element can mean the password genuinely
failed a hidden rule, or it can mean the request collided with the concurrency
ceiling, or it can be a stale error on a retry after the password was already
written. The HTTP status code alone cannot tell these apart, because the
response body carries the authoritative per item outcome, and the customer's
own date_modified timestamp is closer to ground truth than any status code.

This script never auto-resubmits a raw password on a bare 400. It re-checks
every customer whose PUT returned non-2xx by diffing date_modified, and by
calling validate-credentials when that diff is not conclusive, and only queues
a corrective retry for a confirmed still-failed write in a transient status
class. A persistent complexity or history failure is reported to a human, not
retried. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/customer-password-update-random-400/
"""
import os
import time
import logging
from typing import Literal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recheck_password_updates")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "3"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

MAX_CONCURRENT_REQUESTS = 3
MAX_BATCH_SIZE = 10
TRANSIENT_STATUSES = {429}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    body = r.json() if r.text else {}
    return r.status_code, body, r.headers


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    payload = r.json() if r.text else {}
    return r.status_code, payload, r.headers


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    payload = r.json() if r.text else {}
    return r.status_code, payload, r.headers


def _looks_like_concurrency_error(response_body: dict) -> bool:
    title = (response_body.get("title") or "").lower()
    if "concurrent" in title or "rate" in title or "too many" in title:
        return True
    for error in response_body.get("errors") or []:
        text = str(error).lower()
        if "concurrent" in text or "rate" in text:
            return True
    return False


def decide_password_update_outcome(
    pre_date_modified: str,
    post_date_modified: str,
    http_status: int,
    response_body: dict,
    customer_id: int,
    retry_count: int = 0,
) -> Literal["confirmed_success", "needs_retry", "needs_human_review"]:
    """Pure decision. No network, no side effects.

    If post_date_modified advanced past pre_date_modified, the write happened,
    regardless of http_status or the response body. Otherwise a transient
    status class (429, a 500-range error, or a per-item error object naming a
    rate or concurrency problem) gets a bounded retry. Everything else,
    typically a persistent complexity or history validation failure, needs a
    human, never an automatic resend of the raw password.
    """
    if post_date_modified and post_date_modified != pre_date_modified:
        return "confirmed_success"

    is_server_error = 500 <= http_status < 600
    is_rate_or_concurrency = http_status in TRANSIENT_STATUSES or _looks_like_concurrency_error(
        response_body
    )

    if (is_server_error or is_rate_or_concurrency) and retry_count < MAX_RETRIES:
        return "needs_retry"

    return "needs_human_review"


def get_customer_date_modified(customer_id):
    status, body, _ = bc_get("/customers", {"id:in": customer_id})
    data = body.get("data") or []
    return data[0].get("date_modified") if data else None


def update_password(customer_id, new_password):
    body = [{
        "id": customer_id,
        "authentication": {"new_password": new_password, "force_password_reset": False},
    }]
    return bc_put("/customers", body)


def validate_credentials(email, password):
    status, _, _ = bc_post("/customers/validate-credentials", {
        "email": email,
        "password": password,
    })
    return status == 200


def recheck_and_repair(pending_updates):
    """pending_updates: list of dicts with id, email, new_password, pre_date_modified,
    http_status, response_body captured from the original PUT call.

    Confirms each one via date_modified, falling back to validate-credentials,
    then only queues a bounded retry for confirmed transient failures. Returns
    a summary dict for logging.
    """
    confirmed = 0
    retried = 0
    flagged = 0
    in_flight = 0

    for record in pending_updates:
        if in_flight >= MAX_CONCURRENT_REQUESTS:
            time.sleep(0.2)
            in_flight = 0

        customer_id = record["id"]
        post_date_modified = get_customer_date_modified(customer_id)
        in_flight += 1

        outcome = decide_password_update_outcome(
            record["pre_date_modified"],
            post_date_modified,
            record["http_status"],
            record["response_body"],
            customer_id,
            record.get("retry_count", 0),
        )

        if outcome == "confirmed_success":
            log.info("customer_id=%s confirmed_success (date_modified advanced)", customer_id)
            confirmed += 1
            continue

        if outcome == "needs_retry":
            if validate_credentials(record["email"], record["new_password"]):
                log.info(
                    "customer_id=%s confirmed_success via validate-credentials, no resend",
                    customer_id,
                )
                confirmed += 1
                continue

            log.warning(
                "customer_id=%s needs_retry (status=%s), %s",
                customer_id, record["http_status"],
                "dry run, not resending" if DRY_RUN else "resending",
            )
            if not DRY_RUN:
                for batch_start in range(0, 1, MAX_BATCH_SIZE):
                    update_password(customer_id, record["new_password"])
            retried += 1
            continue

        log.error(
            "customer_id=%s needs_human_review (status=%s) email=%s",
            customer_id, record["http_status"], record.get("email"),
        )
        flagged += 1

    log.info(
        "Done. %d confirmed, %d retried, %d flagged for human review.",
        confirmed, retried, flagged,
    )
    return {"confirmed": confirmed, "retried": retried, "flagged": flagged}


def run():
    # In production this list comes from your job's own record of which PUT
    # calls returned non-2xx, captured at call time alongside pre_date_modified.
    pending_updates = []
    recheck_and_repair(pending_updates)


if __name__ == "__main__":
    run()
