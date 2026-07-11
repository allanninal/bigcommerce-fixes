"""Requeue BigCommerce product images dropped by a batch-shaped import.

BigCommerce's v3 Catalog API has no batch endpoint for product images.
POST /v3/catalog/products/{product_id}/images is scoped to create exactly one
image resource per call, a single image_file (multipart/form-data) or a single
image_url (application/json), unlike the batch endpoints that exist for
products (PUT /v3/catalog/products) and variants
(PUT /v3/catalog/products/{product_id}/variants). Import scripts written by
analogy to those batch endpoints, or to the nested images array returned by
GET .../products?include=images, assume the images endpoint also accepts an
array. BigCommerce either 422s on the unexpected shape or the client's
serializer only encodes the first element, so every image after the first is
dropped behind a response that still looks like success. This job reads the
persisted images for each product, diffs them against a source manifest, and
requeues only the images that are actually missing, one POST per image. Safe
to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/bulk-image-api-single-image-per-request/
"""
import json
import logging
import os
import posixpath
from urllib.parse import unquote, urlparse

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("requeue_missing_images")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
SOURCE_MANIFEST_PATH = os.environ.get("SOURCE_MANIFEST_PATH", "./import-manifest.json")
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


def _normalize_key(url_or_name: str) -> str:
    """Reduce a source filename or a BigCommerce CDN URL to a comparable key."""
    if not url_or_name:
        return ""
    path = urlparse(url_or_name).path or url_or_name
    return unquote(posixpath.basename(path)).strip().lower()


def diff_missing_images(source_images: list, persisted_images: list) -> list:
    """Pure function. No network, no side effects.

    source_images: ordered list of source image URLs/filenames for one product.
    persisted_images: the `data` array from GET .../products/{id}/images, each
    dict with at least `image_url`, `id`, and `sort_order`.

    Returns the sublist of source_images whose normalized key (basename or
    canonical URL) is not present among the persisted images' normalized keys,
    preserving source order, so the caller knows exactly which images to
    requeue and in what order.
    """
    persisted_keys = {
        _normalize_key(img.get("image_url", ""))
        for img in (persisted_images or [])
        if img.get("image_url")
    }
    return [
        src for src in (source_images or [])
        if _normalize_key(src) not in persisted_keys
    ]


def next_sort_order(persisted_images: list) -> int:
    if not persisted_images:
        return 0
    return max((img.get("sort_order", 0) for img in persisted_images), default=-1) + 1


def persisted_images(product_id):
    """Page through GET /v3/catalog/products/{product_id}/images."""
    images = []
    page = 1
    while True:
        resp = bc_get(f"/catalog/products/{product_id}/images", {"page": page, "limit": 250})
        batch = resp.get("data", [])
        if not batch:
            return images
        images.extend(batch)
        pagination = resp.get("meta", {}).get("pagination", {})
        if page >= pagination.get("total_pages", page):
            return images
        page += 1


def upload_one_image(product_id, image_url, sort_order):
    """One image per call. The endpoint has no batch mode."""
    return bc_post(
        f"/catalog/products/{product_id}/images",
        {"image_url": image_url, "is_thumbnail": False, "sort_order": sort_order},
    )


def load_source_manifest(path):
    """Expected shape: {"products": [{"product_id": 123, "images": ["https://.../a.jpg", ...]}, ...]}"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run():
    manifest = load_source_manifest(SOURCE_MANIFEST_PATH)
    reconciled = 0
    requeued_total = 0

    for product in manifest.get("products", []):
        product_id = product["product_id"]
        source_images = product.get("images", [])
        if not source_images:
            continue

        current = persisted_images(product_id)
        missing = diff_missing_images(source_images, current)

        if not missing:
            reconciled += 1
            continue

        sort_order = next_sort_order(current)
        for image_url in missing:
            log.info(
                "product_id=%s image_url=%s sort_order=%s (%s)",
                product_id, image_url, sort_order,
                "dry run" if DRY_RUN else "uploading",
            )
            if not DRY_RUN:
                upload_one_image(product_id, image_url, sort_order)
            sort_order += 1
            requeued_total += 1

        if not DRY_RUN:
            after = persisted_images(product_id)
            still_missing = diff_missing_images(source_images, after)
            if still_missing:
                log.warning(
                    "product_id=%s still missing %d image(s) after requeue: %s",
                    product_id, len(still_missing), still_missing,
                )
            else:
                reconciled += 1
                log.info("product_id=%s reconciled, %d image(s) now persisted", product_id, len(after))

    log.info(
        "Done. %d image(s) %s, %d product(s) reconciled.",
        requeued_total, "to requeue" if DRY_RUN else "requeued", reconciled,
    )


if __name__ == "__main__":
    run()
