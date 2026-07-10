"""Find and safely repair BigCommerce products whose variant inventory is not tracked.

inventory_tracking on the parent product is a tri-state setting: "none", "product",
or "variant". It is independent of whether the product actually has variants. A
product can have real size or color SKUs, each carrying its own inventory_level,
while inventory_tracking stays at "none" or "product". In that state BigCommerce's
checkout never reads or decrements per-SKU stock, so a variant can sell forever no
matter what number is displayed in the admin.

This scans every product with GET /v3/catalog/products?include=variants, classifies
each one with a pure function, and for products that need a fix, checks whether
every affected variant already has a non-null inventory_level. If so it is safe to
flip inventory_tracking to "variant" with one PUT. If any variant has no stock
count yet, the product is only flagged, never auto-repaired, since enabling
tracking on a missing count would show a false zero and block real sales. Guarded
by DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/variant-inventory-not-tracked/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_variant_inventory_tracking")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
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


def classify_variant_tracking(product):
    """Pure classification. No network calls.

    product: {"id": int, "inventory_tracking": "none" | "product" | "variant",
              "variants": [{"id": int, "sku": str, "inventory_level": int|None}]}

    Returns {"productId", "needsFix", "reason", "affectedVariantIds"}.

    1. A product with one or zero variants is left alone, since a single default
       variant is expected even for simple products.
    2. A product already tracking at "variant" is already correctly configured.
    3. Otherwise, a product with real option-level SKUs (more than one variant) and
       tracking at "none" or "product" needs a fix. Every variant id is returned as
       affected so the caller can check their inventory_level before repairing.
    """
    variants = product.get("variants") or []
    if len(variants) <= 1:
        return {"productId": product["id"], "needsFix": False, "reason": None, "affectedVariantIds": []}

    if product.get("inventory_tracking") == "variant":
        return {"productId": product["id"], "needsFix": False, "reason": None, "affectedVariantIds": []}

    reason = (
        "tracking_disabled_entirely"
        if product.get("inventory_tracking") == "none"
        else "tracking_set_to_product_level_not_variant"
    )
    return {
        "productId": product["id"],
        "needsFix": True,
        "reason": reason,
        "affectedVariantIds": [v["id"] for v in variants],
    }


def all_variants_have_stock(variants, affected_ids):
    """True only when every affected variant already has a non-null inventory_level.

    This is the safety guard: flipping inventory_tracking to "variant" on a variant
    whose stock was never counted would show it as zero and block sales.
    """
    by_id = {v["id"]: v for v in variants}
    return all(by_id.get(vid, {}).get("inventory_level") is not None for vid in affected_ids)


def all_products():
    """Yield every product with its variants, paginated."""
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v3/catalog/products?include=variants&limit={limit}&page={page}")
        if not batch:
            return
        for product in batch:
            yield product
        if len(batch) < limit:
            return
        page += 1


def set_variant_tracking(product_id):
    """The one field write: turn on per-SKU tracking. No stock count is sent or mutated."""
    return bc("PUT", f"/v3/catalog/products/{product_id}", json={"inventory_tracking": "variant"})


def run():
    repaired = 0
    flagged = 0
    for product in all_products():
        decision = classify_variant_tracking(product)
        if not decision["needsFix"]:
            continue

        variants = product.get("variants") or []
        if not all_variants_have_stock(variants, decision["affectedVariantIds"]):
            log.warning(
                "Product %s needs a fix (%s) but has a variant with no inventory_level. Flagging for review.",
                decision["productId"], decision["reason"],
            )
            flagged += 1
            continue

        log.info(
            "Product %s eligible (%s). %s",
            decision["productId"], decision["reason"],
            "would set inventory_tracking=variant" if DRY_RUN else "setting inventory_tracking=variant",
        )
        if not DRY_RUN:
            result = set_variant_tracking(decision["productId"])
            log.info(
                "Product %s inventory_tracking is now %s",
                decision["productId"], (result or {}).get("inventory_tracking"),
            )
        repaired += 1

    log.info(
        "Done. %d product(s) %s, %d product(s) flagged for review.",
        repaired, "to repair" if DRY_RUN else "repaired", flagged,
    )


if __name__ == "__main__":
    run()
