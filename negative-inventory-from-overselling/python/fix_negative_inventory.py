"""Find and safely repair BigCommerce variants that oversold into negative inventory.

inventory_level on a variant is meant to floor at zero. But when two checkouts
decrement the same low-stock SKU at nearly the same moment, or a bulk import
writes a negative delta, or a channel sync double counts a sale, the number can
end up below zero. BigCommerce keeps selling a SKU that reads -3 exactly the same
as one that reads 30, because nothing in checkout refuses a negative count.

This scans every product with GET /v3/catalog/products?include=variants, finds
variants whose inventory_level is below zero, and classifies each one with a pure
function. A negative count on a product with inventory_tracking off is not really
a stock problem and is left alone. A negative count on a tracked variant is
repaired by posting an absolute adjustment back to zero with
POST /v3/inventory/adjustments/absolute, and the lost quantity is kept in the
result so it can be logged for restock and demand planning. Guarded by DRY_RUN.
Safe to run again and again, since a variant already at zero or above is skipped.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_negative_inventory")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ADJUSTMENT_REASON = os.environ.get("ADJUSTMENT_REASON", "negative_inventory_overselling_repair")


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


def classify_negative_inventory(product, variant):
    """Pure classification. No network calls.

    product: {"id": int, "inventory_tracking": "none" | "product" | "variant"}
    variant: {"id": int, "sku": str, "inventory_level": int}

    Returns {"productId", "variantId", "sku", "needsFix", "oversoldBy"}.

    1. If the product does not track inventory at the variant level, a negative
       number on that variant is cosmetic, not a real oversell, so it is left alone.
    2. If inventory_level is zero or positive, there is nothing to repair.
    3. Otherwise the variant is genuinely oversold. oversoldBy is the positive
       quantity that sold past zero, kept so the caller can log it for restock
       and demand planning before the count is corrected back to zero.
    """
    if product.get("inventory_tracking") != "variant":
        return {
            "productId": product["id"], "variantId": variant["id"], "sku": variant.get("sku"),
            "needsFix": False, "oversoldBy": 0,
        }

    level = variant.get("inventory_level", 0)
    if level >= 0:
        return {
            "productId": product["id"], "variantId": variant["id"], "sku": variant.get("sku"),
            "needsFix": False, "oversoldBy": 0,
        }

    return {
        "productId": product["id"], "variantId": variant["id"], "sku": variant.get("sku"),
        "needsFix": True, "oversoldBy": abs(level),
    }


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


def reset_variant_to_zero(sku, reason):
    """Post an absolute inventory adjustment that floors a SKU back to zero."""
    payload = {"reason": reason, "items": [{"sku": sku, "quantity": 0}]}
    return bc("POST", "/v3/inventory/adjustments/absolute", json=payload)


def run():
    repaired = 0
    total_oversold = 0
    for product in all_products():
        for variant in product.get("variants") or []:
            decision = classify_negative_inventory(product, variant)
            if not decision["needsFix"]:
                continue

            log.warning(
                "SKU %s (variant %s) oversold by %d units. %s",
                decision["sku"], decision["variantId"], decision["oversoldBy"],
                "would reset to 0" if DRY_RUN else "resetting to 0",
            )
            if not DRY_RUN:
                reset_variant_to_zero(decision["sku"], ADJUSTMENT_REASON)
            repaired += 1
            total_oversold += decision["oversoldBy"]

    log.info(
        "Done. %d variant(s) %s, %d unit(s) oversold in total.",
        repaired, "to reset" if DRY_RUN else "reset to 0", total_oversold,
    )


if __name__ == "__main__":
    run()
