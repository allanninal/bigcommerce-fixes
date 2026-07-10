"""Find and repair broken BigCommerce product images.

A product image record on /v3/catalog/products/{product_id}/images stores
metadata and derived CDN URLs (url_zoom, url_standard, url_thumbnail, url_tiny)
that point at a file BigCommerce's image service is expected to serve, but the
underlying file can go missing while the database row survives. This commonly
follows a bulk CSV/V2 import that set image_url to a URL that was never truly
fetched, a WMS/PIM sync that wrote a row referencing a file deleted or renamed
before BigCommerce could pull it, or a botched Stencil/CDN migration or app
cleanup that purges files without deleting the matching image records.

This pages through GET /v3/catalog/products?include=images&limit=250 across
the full catalog, checks the status of every image URL, classifies each image
with a pure decision function, and in write mode clears a confirmed-dead
reference (self-healing with a replacement URL if one is known, otherwise
deleting the row) and promotes the next image to thumbnail if the one removed
was the product's thumbnail. It never deletes on sight: everything is flagged
for review by default. Guarded by DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/broken-product-images/
"""
import os
import re
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_broken_images")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Optional map of broken image_url -> known-good replacement URL, comma-separated
# pairs "old=>new". Left empty by default so broken images with no confirmed
# replacement fall back to a logged delete instead of a guess.
_raw_replacements = os.environ.get("REPLACEMENT_URLS", "")
REPLACEMENT_URLS = {}
for pair in _raw_replacements.split(","):
    if "=>" in pair:
        old, new = pair.split("=>", 1)
        if old.strip() and new.strip():
            REPLACEMENT_URLS[old.strip()] = new.strip()

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    if not r.content:
        return None
    body = r.json()
    return body["data"] if isinstance(body, dict) and "data" in body else body


def _is_malformed(url):
    return not isinstance(url, str) or not url.strip() or not _URL_RE.match(url.strip())


def decide_image_action(image, url_status, remaining_images):
    """Pure decision. No network calls, no side effects.

    image: {"id", "image_url", "url_standard", "is_thumbnail", "sort_order"}
    url_status: mapping of URL -> HTTP status code (or None if unreachable),
                obtained by the caller beforehand.
    remaining_images: sibling images still on the product.

    Returns "ok", "flag_only", "clear_reference", or "promote_thumbnail".
    """
    url = image.get("url_standard") or image.get("image_url")

    if _is_malformed(url):
        return "flag_only"

    status = url_status.get(url)
    if status is not None and 200 <= status < 300:
        return "ok"

    if status not in (403, 404):
        return "flag_only"

    siblings = [i for i in remaining_images if i.get("id") != image.get("id")]
    if not siblings:
        return "flag_only"

    def sibling_ok(s):
        s_url = s.get("url_standard") or s.get("image_url")
        if _is_malformed(s_url):
            return False
        s_status = url_status.get(s_url)
        return s_status is None or s_status not in (403, 404)

    if image.get("is_thumbnail") and any(sibling_ok(s) for s in siblings):
        return "promote_thumbnail"

    return "clear_reference"


def check_url_status(url):
    """I/O helper: HEAD (falling back to GET) a URL and return its status code,
    or None if the request could not complete at all."""
    try:
        r = requests.head(url, timeout=15, allow_redirects=True)
        if r.status_code == 405:
            r = requests.get(url, timeout=15, stream=True)
        return r.status_code
    except requests.RequestException:
        return None


def all_products():
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v3/catalog/products?include=images&limit={limit}&page={page}")
        if not batch:
            return
        for product in batch:
            yield product
        if len(batch) < limit:
            return
        page += 1


def clear_reference(product_id, image_id, replacement_url=None):
    if replacement_url:
        return bc("PUT", f"/v3/catalog/products/{product_id}/images/{image_id}",
                  json={"image_url": replacement_url})
    return bc("DELETE", f"/v3/catalog/products/{product_id}/images/{image_id}")


def promote_thumbnail(product_id, remaining_images, broken_image_id):
    candidates = sorted(
        (i for i in remaining_images if i.get("id") != broken_image_id),
        key=lambda i: i.get("sort_order", 0),
    )
    if not candidates:
        return None
    next_image = candidates[0]
    return bc("PUT", f"/v3/catalog/products/{product_id}/images/{next_image['id']}",
              json={"is_thumbnail": True})


def run():
    flagged = 0
    cleared = 0
    promoted = 0

    for product in all_products():
        images = product.get("images") or []
        url_status = {}
        for image in images:
            url = image.get("url_standard") or image.get("image_url")
            if url and not _is_malformed(url):
                url_status[url] = check_url_status(url)

        for image in images:
            action = decide_image_action(image, url_status, images)
            if action == "ok":
                continue

            url = image.get("url_standard") or image.get("image_url")
            log.warning(
                "product=%s image=%s sort_order=%s action=%s url=%r before=%r",
                product["id"], image.get("id"), image.get("sort_order"), action, url, image,
            )
            flagged += 1

            if DRY_RUN:
                continue

            if action == "clear_reference":
                replacement = REPLACEMENT_URLS.get(url)
                clear_reference(product["id"], image["id"], replacement)
                cleared += 1
            elif action == "promote_thumbnail":
                replacement = REPLACEMENT_URLS.get(url)
                clear_reference(product["id"], image["id"], replacement)
                promote_thumbnail(product["id"], images, image["id"])
                cleared += 1
                promoted += 1

    log.info(
        "Done. %d image(s) flagged, %d cleared, %d thumbnail(s) promoted. (%s)",
        flagged, cleared, promoted, "dry run" if DRY_RUN else "write mode",
    )


if __name__ == "__main__":
    run()
