"""Find and safely repair BigCommerce products with no category assigned.

A product's categories field is just an array of category ids, and nothing
about creating a product through POST /v3/catalog/products or a bulk import
requires that array to be non-empty. When it ships empty, the product saves
fine and stays reachable by direct link, but it never appears on any category
page, navigation menu, or facet a normal shopper uses to browse.

This scans every product with GET /v3/catalog/products, classifies each one
with a pure function, and for every stranded product (an empty categories
array) assigns one clearly labeled fallback category with a single PUT. It
never guesses a specific category from the product name, and it never touches
a product that already has at least one category. Guarded by DRY_RUN. Safe to
run again and again.

Guide: https://www.allanninal.dev/bigcommerce/products-stranded-with-no-category/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_stranded_products")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
FALLBACK_CATEGORY_ID = int(os.environ.get("FALLBACK_CATEGORY_ID", "0"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


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


def is_stranded(product):
    """Pure classification. No network calls.

    product: {"id": int, "name": str, "categories": [int, ...]}

    Returns True only when the product's categories array is missing or
    empty. A product with even one category id already is not stranded and
    is left completely alone.
    """
    categories = product.get("categories") or []
    return len(categories) == 0


def all_products():
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v3/catalog/products?limit={limit}&page={page}")
        if not batch:
            return
        for product in batch:
            yield product
        if len(batch) < limit:
            return
        page += 1


def assign_fallback_category(product_id, fallback_category_id):
    return bc("PUT", f"/v3/catalog/products/{product_id}", json={"categories": [fallback_category_id]})


def run():
    if not FALLBACK_CATEGORY_ID:
        raise RuntimeError("FALLBACK_CATEGORY_ID must be set to a real category id before running.")

    fixed = 0
    for product in all_products():
        if not is_stranded(product):
            continue
        log.info(
            "Product %s (%s) has no category. %s",
            product["id"], product.get("name"),
            "would assign fallback" if DRY_RUN else "assigning fallback",
        )
        if not DRY_RUN:
            assign_fallback_category(product["id"], FALLBACK_CATEGORY_ID)
        fixed += 1
    log.info("Done. %d product(s) %s.", fixed, "to assign" if DRY_RUN else "assigned a fallback category")


if __name__ == "__main__":
    run()
