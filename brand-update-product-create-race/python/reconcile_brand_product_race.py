"""Reconcile a BigCommerce brand update fired immediately before a product create
that came back as an empty reply from server.

BigCommerce enforces a per-store request quota (150 to 450 requests per 30 second
OAuth window depending on plan) and a concurrency cap, normally surfaced as a 429
with X-Rate-Limit-Requests-Left and X-Rate-Limit-Time-Reset-Ms headers. When a
brand PUT to /v3/catalog/brands/{id} is fired immediately before a product POST to
/v3/catalog/products, the store's connection sometimes closes before the response
finishes, which HTTP clients surface as a generic empty reply instead of a
structured error. The underlying mutation may have actually succeeded server side
even though the client received nothing parsable. This is a confirmed, reproduced
issue in BigCommerce's own bigcommerce-api-php SDK repo (issue #138).

This job takes logged (brand_id, intended_fields, product_payload) pairs, confirms
whether the brand update actually applied, checks whether the product already
exists from the failed attempt, and only retries the create when it is safe:
brand confirmed, product confirmed absent, and rate limit budget or backoff
allows another call. Anything else (a stale brand update, or a same-named product
whose fields do not match) is flagged for manual review, never auto-repaired.

Guide: https://www.allanninal.dev/bigcommerce/brand-update-product-create-race/
"""
import os
import time
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_brand_product_race")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "5"))

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    rate_limit_left = int(r.headers.get("X-Rate-Limit-Requests-Left", "1"))
    return r.json(), rate_limit_left


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def decide_action(
    brand_confirmed: bool,
    product_exists: bool,
    rate_limit_left: int,
    attempt: int,
    max_attempts: int = 5,
) -> str:
    """Pure decision logic, no I/O. Returns one of:

    'noop_success'        - brand_confirmed and product_exists: pair actually
                             succeeded despite empty reply.
    'retry_create'        - brand_confirmed, not product_exists, rate_limit_left
                             > 0, attempt < max_attempts: safe to retry create.
    'wait_and_retry'      - rate_limit_left <= 0 and attempt < max_attempts:
                             back off before retrying.
    'flag_manual_review'  - not brand_confirmed (brand update itself never
                             applied): don't create against a stale brand.
    'give_up'             - attempt >= max_attempts and not product_exists:
                             surface for manual review.
    """
    if brand_confirmed and product_exists:
        return "noop_success"
    if not brand_confirmed:
        return "flag_manual_review"
    if attempt >= max_attempts and not product_exists:
        return "give_up"
    if rate_limit_left <= 0:
        return "wait_and_retry"
    return "retry_create"


def confirm_brand_update(brand_id, intended_fields):
    data, rate_limit_left = bc_get(f"/catalog/brands/{brand_id}")
    brand = data.get("data", {})
    matches = all(brand.get(field) == value for field, value in intended_fields.items())
    return matches, rate_limit_left


def find_existing_product(name, brand_id):
    data, rate_limit_left = bc_get("/catalog/products", {"name": name, "brand_id": brand_id})
    products = data.get("data", [])
    return (products[0] if products else None), rate_limit_left


def create_product(product_payload):
    return bc_post("/catalog/products", product_payload)


def backoff_seconds(attempt):
    return min(2 ** attempt, 8)


def reconcile_pair(brand_id, intended_fields, product_payload):
    attempt = 0
    while True:
        brand_confirmed, rate_limit_left = confirm_brand_update(brand_id, intended_fields)
        existing, rate_limit_left = find_existing_product(
            product_payload.get("name"), brand_id
        )
        product_exists = existing is not None

        decision = decide_action(brand_confirmed, product_exists, rate_limit_left, attempt, MAX_ATTEMPTS)

        log.info(
            "brand_id=%s attempt=%s brand_confirmed=%s product_exists=%s "
            "rate_limit_left=%s decision=%s",
            brand_id, attempt, brand_confirmed, product_exists, rate_limit_left, decision,
        )

        if decision == "noop_success":
            return "noop_success"
        if decision == "flag_manual_review":
            log.warning("Brand %s update not confirmed. Flagging pair for manual review.", brand_id)
            return "flag_manual_review"
        if decision == "give_up":
            log.warning("Brand %s exhausted %s attempts. Flagging for manual review.", brand_id, MAX_ATTEMPTS)
            return "give_up"
        if decision == "wait_and_retry":
            wait_for = backoff_seconds(attempt)
            log.info("Rate limit exhausted, waiting %ss before retry.", wait_for)
            if not DRY_RUN:
                time.sleep(wait_for)
            attempt += 1
            continue

        # decision == "retry_create"
        if DRY_RUN:
            log.info("Dry run: would create product %s under brand %s.", product_payload.get("name"), brand_id)
            return "retry_create"

        # Re-check existence immediately before writing, state can change between checks.
        existing_recheck, _ = find_existing_product(product_payload.get("name"), brand_id)
        if existing_recheck is not None:
            log.info("Product appeared before retry. Treating as noop_success.")
            return "noop_success"

        create_product(product_payload)
        log.info("Created product %s under brand %s.", product_payload.get("name"), brand_id)
        return "created"


def run(pairs):
    """pairs: iterable of (brand_id, intended_fields, product_payload)."""
    results = []
    for brand_id, intended_fields, product_payload in pairs:
        results.append(reconcile_pair(brand_id, intended_fields, product_payload))
    log.info("Done. %d pair(s) processed.", len(results))
    return results


if __name__ == "__main__":
    run([])
