"""Find and safely report stale product modifiers left behind after a BigCommerce import.

The CSV product import and export tools can only edit price and weight adjusters on
modifier option_values that already exist. They cannot create, delete, or fully
re-link one. So when a migration or bulk-import tool deletes and recreates variants
with new SKUs and variant IDs, or replaces the product a product_list or
product_list_with_images modifier points at, the old modifier and its option_values
survive on the parent product. They still return from the API and render in the
admin, but they reference a variant SKU or a value_data.product_id that no longer
exists, so they cannot resolve at checkout.

This pages through GET /v3/catalog/products?include=variants,options,modifiers&limit=250,
reads each product's modifiers, and classifies them with a pure function against the
product's current variant SKUs and the live catalog's product ids. In write mode it
deletes a modifier only when every option_value is a confirmed dead reference, and
strips just the dangling entries when some values are still valid. Anything ambiguous
is recorded in an audit list instead of written. Guarded by DRY_RUN. Safe to run again
and again.

Guide: https://www.allanninal.dev/bigcommerce/stale-product-modifiers-after-import/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_stale_modifiers")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRODUCT_LIST_TYPES = {"product_list", "product_list_with_images"}


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    if not r.content:
        return True
    body = r.json()
    return body["data"] if isinstance(body, dict) and "data" in body else body


def find_stale_modifiers(modifiers, live_variant_skus, live_product_ids):
    """Pure decision logic (no I/O). Given one product's modifiers (as returned by
    GET /v3/catalog/products/{id}/modifiers), the set of SKUs currently in
    GET /v3/catalog/products/{id}/variants, and the set of product IDs known to
    still exist in the catalog, return the list of modifier dicts judged stale.

    A modifier is stale if:
      - type in {"product_list", "product_list_with_images"} and any
        option_values[].value_data.product_id is not in live_product_ids; or
      - any option_values[].value_data.sku (or adjusters-linked variant sku) is
        not in live_variant_skus; or
      - is_required is True and option_values is empty.
    """
    stale = []
    for modifier in modifiers:
        option_values = modifier.get("option_values") or []

        if modifier.get("is_required") and not option_values:
            stale.append(modifier)
            continue

        is_stale = False
        for value in option_values:
            value_data = value.get("value_data") or {}

            if modifier.get("type") in PRODUCT_LIST_TYPES:
                product_id = value_data.get("product_id")
                if product_id is not None and product_id not in live_product_ids:
                    is_stale = True
                    break

            sku = value_data.get("sku")
            if sku and sku not in live_variant_skus:
                is_stale = True
                break

        if is_stale:
            stale.append(modifier)

    return stale


def all_products_with_modifiers():
    """Yield every product with its variants and modifiers included, paginated."""
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v3/catalog/products?include=variants,options,modifiers&limit={limit}&page={page}")
        if not batch:
            return
        for product in batch:
            yield product
        if len(batch) < limit:
            return
        page += 1


def live_variant_skus(product):
    return {v["sku"] for v in product.get("variants") or [] if v.get("sku")}


def product_exists(product_id):
    return bc("GET", f"/v3/catalog/products/{product_id}") is not None


def all_dead_references(modifier, live_variant_skus_set, live_product_ids):
    """True only if every option_value on this modifier is a confirmed dead reference."""
    option_values = modifier.get("option_values") or []
    if not option_values:
        return True
    for value in option_values:
        value_data = value.get("value_data") or {}
        product_id = value_data.get("product_id")
        sku = value_data.get("sku")
        product_dead = (
            modifier.get("type") in PRODUCT_LIST_TYPES
            and product_id is not None
            and product_id not in live_product_ids
        )
        sku_dead = bool(sku) and sku not in live_variant_skus_set
        if not (product_dead or sku_dead):
            return False
    return True


def delete_modifier(product_id, modifier_id):
    return bc("DELETE", f"/v3/catalog/products/{product_id}/modifiers/{modifier_id}")


def strip_dangling_option_values(product_id, modifier_id, modifier, live_variant_skus_set, live_product_ids):
    """PUT the modifier back with only the option_values that still resolve."""
    kept = []
    for value in modifier.get("option_values") or []:
        value_data = value.get("value_data") or {}
        product_id_ref = value_data.get("product_id")
        sku = value_data.get("sku")
        if modifier.get("type") in PRODUCT_LIST_TYPES and product_id_ref is not None:
            if product_id_ref not in live_product_ids:
                continue
        if sku and sku not in live_variant_skus_set:
            continue
        kept.append(value)
    return bc("PUT", f"/v3/catalog/products/{product_id}/modifiers/{modifier_id}",
              json={"option_values": kept})


def run():
    audit = []
    acted = 0

    for product in all_products_with_modifiers():
        modifiers = product.get("modifiers") or []
        if not modifiers:
            continue

        skus = live_variant_skus(product)
        product_ids_seen = {
            v.get("value_data", {}).get("product_id")
            for m in modifiers
            for v in (m.get("option_values") or [])
            if v.get("value_data", {}).get("product_id") is not None
        }
        live_product_ids = {pid for pid in product_ids_seen if product_exists(pid)}

        stale = find_stale_modifiers(modifiers, skus, live_product_ids)
        for modifier in stale:
            product_id = product["id"]
            modifier_id = modifier["id"]

            if all_dead_references(modifier, skus, live_product_ids):
                log.warning("Product %s modifier %s fully orphaned. %s",
                            product_id, modifier_id, "would delete" if DRY_RUN else "deleting")
                if not DRY_RUN:
                    delete_modifier(product_id, modifier_id)
                acted += 1
            elif modifier.get("is_required") and not (modifier.get("option_values") or []):
                log.warning("Product %s modifier %s is required with zero option_values, needs a human. Recording to audit list.",
                            product_id, modifier_id)
                audit.append({"product_id": product_id, "modifier_id": modifier_id, "reason": "required_no_values"})
            else:
                log.warning("Product %s modifier %s has some dangling option_values. %s",
                            product_id, modifier_id, "would strip" if DRY_RUN else "stripping")
                if not DRY_RUN:
                    strip_dangling_option_values(product_id, modifier_id, modifier, skus, live_product_ids)
                acted += 1

    log.info("Done. %d stale modifier(s) %s, %d recorded for review.",
              acted, "to act on" if DRY_RUN else "acted on", len(audit))
    return audit


if __name__ == "__main__":
    run()
