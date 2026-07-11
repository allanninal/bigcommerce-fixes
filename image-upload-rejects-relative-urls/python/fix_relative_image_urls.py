"""Find zero-image BigCommerce products and fix the non fully qualified image_url cause.

BigCommerce creates a product image by URL through
POST /v3/catalog/products/{product_id}/images with a JSON body containing
image_url, and BigCommerce's own servers fetch that remote file server-side.
Because of that server-side fetch, image_url must be a fully qualified absolute
URL, a scheme (http or https) plus a host. A relative path, a protocol-relative
URL, or a bare filename has no scheme or host for BigCommerce's fetcher to
resolve, so the request is rejected with a 422 image_url is invalid error. This
hits bulk or CSV migration imports the hardest, since the source system often
stored image paths relative to its own web root. The product record itself is
created before the image call runs, so the failed image row does not roll back
the product, it just leaves a real product with zero images and no automatic
retry.

This job lists every zero-image product, cross-references each one against the
import job's failure log for the original image_url, and uses a pure decision
function to classify it as already valid, fixable against a known source base
URL, or in need of human review. It only retries the create-image call for the
first two cases. Nothing is ever guessed; a URL that cannot be safely resolved
is routed to review instead of risking the wrong image on the wrong product.

Guide: https://www.allanninal.dev/bigcommerce/image-upload-rejects-relative-urls/
"""
import os
import logging
from urllib.parse import urlsplit, urljoin

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_relative_image_urls")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
SOURCE_BASE_URL = os.environ.get("SOURCE_BASE_URL") or None
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def is_fixable_image_url(raw_url: str, source_base_url: str | None = None) -> dict:
    """Pure decision. No network, no I/O.

    If raw_url already parses with scheme http/https and a non-empty netloc,
    it is already_valid. If raw_url has a scheme that is neither http nor
    https (ftp, data, and so on), it is unsupported_scheme. Otherwise it is
    treated as the non fully qualified defect: if source_base_url is itself a
    valid absolute http/https URL, resolve raw_url against it with urljoin and
    return fixable. If there is no usable base URL, return needs_review.
    """
    parts = urlsplit(raw_url or "")

    if parts.scheme in ("http", "https") and parts.netloc:
        return {"status": "already_valid", "resolved_url": raw_url}

    if parts.scheme and parts.scheme not in ("http", "https"):
        return {"status": "unsupported_scheme", "resolved_url": None}

    base_parts = urlsplit(source_base_url or "")
    base_is_valid = (
        source_base_url is not None
        and base_parts.scheme in ("http", "https")
        and bool(base_parts.netloc)
    )
    if base_is_valid:
        return {"status": "fixable", "resolved_url": urljoin(source_base_url, raw_url)}

    return {"status": "needs_review", "resolved_url": None}


def zero_image_products():
    """Page through products with images included, yielding the zero-image ones."""
    page = 1
    while True:
        resp = bc_get("/catalog/products", {"include": "images", "limit": 250, "page": page})
        products = resp.get("data") or []
        if not products:
            return
        for product in products:
            if not product.get("images"):
                yield product
        total_pages = resp.get("meta", {}).get("pagination", {}).get("total_pages", page)
        if page >= total_pages:
            return
        page += 1


def failed_image_url_for(product_id, failure_log):
    """failure_log maps product_id -> original recorded image_url from the
    import job's failure log. Returns None if this product has no matching
    failure row, which means the zero-image state has some other cause."""
    return failure_log.get(product_id)


def create_product_image(product_id, resolved_url):
    return bc_post(
        f"/catalog/products/{product_id}/images",
        {"image_url": resolved_url, "is_thumbnail": True},
    )


def run(failure_log=None):
    failure_log = failure_log or {}
    retried = 0
    reviewed = 0

    for product in zero_image_products():
        product_id = product["id"]
        raw_url = failed_image_url_for(product_id, failure_log)

        if raw_url is None:
            log.info("product_id=%s has zero images but no matching failure log entry, skipping", product_id)
            continue

        decision = is_fixable_image_url(raw_url, SOURCE_BASE_URL)

        if decision["status"] in ("needs_review", "unsupported_scheme"):
            log.warning(
                "product_id=%s needs review. status=%s original_image_url=%s",
                product_id, decision["status"], raw_url,
            )
            reviewed += 1
            continue

        resolved_url = decision["resolved_url"]
        log.info(
            "product_id=%s status=%s original_image_url=%s resolved_url=%s (%s)",
            product_id, decision["status"], raw_url, resolved_url,
            "dry run" if DRY_RUN else "retrying",
        )
        if not DRY_RUN:
            create_product_image(product_id, resolved_url)
        retried += 1

    log.info(
        "Done. %d product(s) %s, %d product(s) routed to review.",
        retried, "to retry" if DRY_RUN else "retried", reviewed,
    )


if __name__ == "__main__":
    run()
