"""Repair BigCommerce category images without resending image_file as JSON.

BigCommerce's V3 Catalog Categories JSON endpoint (PUT /v3/catalog/categories)
only accepts image_url for setting or replacing a category's image. image_file
is a real field, but it belongs to the separate multipart/form-data endpoint,
POST /v3/catalog/categories/{category_id}/image, which needs
Content-Type: multipart/form-data, not JSON. A sync script that PUTs image_file
as JSON to the categories endpoint gets a 400, "the field 'image_file' is
invalid", because that resource's schema has no such property. This job lists
categories, compares each one's image_url against a source-of-truth image
source, and repairs it with the correct call for whatever source is available:
image_url as JSON when a public URL exists, or image_file as multipart when
only a local file exists. A category with neither is flagged for manual
review, never guessed at. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/category-image-file-rejected/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_category_images")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
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


def bc_put_json(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_post_multipart(path, file_path):
    headers = {"X-Auth-Token": ACCESS_TOKEN, "Accept": "application/json"}
    with open(file_path, "rb") as fh:
        files = {"image_file": (os.path.basename(file_path), fh)}
        r = requests.post(f"{API_BASE}{path}", headers=headers, files=files, timeout=60)
    r.raise_for_status()
    return r.json()


def choose_image_repair_strategy(category: dict, image_source: dict) -> dict:
    """Pure decision. No network, no side effects.

    category = {"id": int, "image_url": str|None} the current BigCommerce state.
    image_source = {"public_url": str|None, "local_file_path": str|None} what we
    have on file for this category.

    If image_url is missing, or differs from an available public_url, repair
    with put_image_url (JSON, image_url field). Otherwise, if only a local file
    exists, repair with post_multipart_image (multipart, image_file field,
    scoped to this category's id). If neither source is available, flag for a
    human. This function must never return action="put_image_url" paired with
    field="image_file", that pairing is exactly the 400-triggering bug.
    """
    current_url = category.get("image_url")
    public_url = image_source.get("public_url")
    local_file_path = image_source.get("local_file_path")

    if public_url and (not current_url or current_url != public_url):
        return {
            "action": "put_image_url",
            "endpoint": "/v3/catalog/categories",
            "field": "image_url",
            "value": public_url,
        }

    if local_file_path:
        return {
            "action": "post_multipart_image",
            "endpoint": f"/v3/catalog/categories/{category['id']}/image",
            "field": "image_file",
            "value": local_file_path,
        }

    return {"action": "flag", "reason": "no_image_source_available"}


def all_categories():
    page = 1
    while True:
        result = bc_get("/catalog/categories", {"limit": 250, "page": page})
        for category in result.get("data", []):
            yield category
        pagination = result.get("meta", {}).get("pagination", {})
        if page >= pagination.get("total_pages", page):
            return
        page += 1


def apply_repair(category_id, strategy):
    if strategy["action"] == "put_image_url":
        return bc_put_json("/catalog/categories", [{"id": category_id, "image_url": strategy["value"]}])
    if strategy["action"] == "post_multipart_image":
        return bc_post_multipart(f"/catalog/categories/{category_id}/image", strategy["value"])
    return None


def load_image_source(category_id):
    """Placeholder for your source-of-truth lookup. Replace with a real
    catalog/DB/CMS query that returns {"public_url": ..., "local_file_path": ...}
    for the given category_id, using None for whichever is not available."""
    return {"public_url": None, "local_file_path": None}


def run():
    repaired = 0
    flagged = 0
    for category in all_categories():
        category_id = category["id"]
        image_source = load_image_source(category_id)
        strategy = choose_image_repair_strategy(category, image_source)

        if strategy["action"] == "flag":
            log.warning(
                "Category %s flagged. reason=%s current_image_url=%s",
                category_id, strategy["reason"], category.get("image_url"),
            )
            flagged += 1
            continue

        log.info(
            "category_id=%s action=%s endpoint=%s field=%s (%s)",
            category_id, strategy["action"], strategy["endpoint"], strategy["field"],
            "dry run" if DRY_RUN else "applying",
        )
        if not DRY_RUN:
            apply_repair(category_id, strategy)
        repaired += 1

    log.info(
        "Done. %d categor%s %s, %d categor%s flagged for review.",
        repaired, "y" if repaired == 1 else "ies", "to repair" if DRY_RUN else "repaired",
        flagged, "y" if flagged == 1 else "ies",
    )


if __name__ == "__main__":
    run()
