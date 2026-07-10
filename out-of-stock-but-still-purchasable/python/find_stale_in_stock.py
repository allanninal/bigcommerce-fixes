"""Find BigCommerce products and variants that are out of stock but still purchasable.

BigCommerce only blocks checkout for a SKU when three fields agree: inventory_tracking
is scoped correctly ("product" for simple products or "variant" for SKU-level options),
the matching inventory_level is at or below zero, and availability is not forced to
"available". A common break is inventory_tracking left at "none", or scoped at the
product level while stock is really managed per variant. In that state BigCommerce
never evaluates stock at all, so the storefront and API accept orders no matter what
inventory_level says. The same gap shows up after an import writes zero to a product
but not its variants, or after a dead inventory webhook leaves inventory_level stale.

This scans every product with GET /v3/catalog/products?include=variants, classifies
each product and each of its variants with a pure function, and logs every "phantom
in-stock" record. This is a detect-and-flag tool: it never mutates live availability
on its own. A correction only runs for a product id you pass in CONFIRMED_PRODUCT_IDS,
meaning a human has verified the product should truly be disabled, and even then it is
guarded by DRY_RUN and re-reads the record afterward to confirm the write persisted.
Safe to run again and again.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_stale_in_stock")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Product ids a human has explicitly confirmed should be corrected. Left empty by
# default so the script only ever flags until you deliberately opt a product in.
CONFIRMED_PRODUCT_IDS = {
    int(x) for x in os.environ.get("CONFIRMED_PRODUCT_IDS", "").split(",") if x.strip()
}

TRACKED_MODES = {"product", "variant"}
CORRECTION_PAYLOAD = {"inventory_tracking": "product", "inventory_level": 0, "availability": "disabled"}


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


def is_stale_in_stock(inventory_tracking, inventory_level, availability, purchasing_disabled):
    """Pure decision. No network calls, no side effects.

    Returns True (flag as "out of stock but still purchasable") only when
    inventory_tracking is in ("product", "variant"), inventory_level is at or
    below zero, availability is "available", and purchasing_disabled is False.
    Returns False for untracked SKUs, correctly disabled SKUs, or SKUs genuinely
    still in stock.
    """
    if inventory_tracking not in TRACKED_MODES:
        return False
    if inventory_level > 0:
        return False
    if availability != "available":
        return False
    return purchasing_disabled is False


def all_products():
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


def flagged_records(product):
    """Yield (kind, id, sku) tuples for every stale in-stock record on a product."""
    if is_stale_in_stock(
        product.get("inventory_tracking"),
        product.get("inventory_level", 0),
        product.get("availability"),
        product.get("purchasing_disabled", False),
    ):
        yield ("product", product["id"], product.get("sku", ""))

    for variant in product.get("variants") or []:
        if is_stale_in_stock(
            product.get("inventory_tracking"),
            variant.get("inventory_level", 0),
            product.get("availability"),
            variant.get("purchasing_disabled", False),
        ):
            yield ("variant", variant["id"], variant.get("sku", ""))


def disable_confirmed_product(product_id):
    """Only call this for a product_id present in CONFIRMED_PRODUCT_IDS."""
    bc("PUT", f"/v3/catalog/products/{product_id}", json=CORRECTION_PAYLOAD)
    confirmed = bc("GET", f"/v3/catalog/products/{product_id}")
    ok = confirmed.get("inventory_level") == 0 and confirmed.get("availability") == "disabled"
    if not ok:
        raise RuntimeError(f"Product {product_id} did not persist the correction")
    return confirmed


def run():
    flagged = 0
    corrected = 0
    for product in all_products():
        for kind, record_id, sku in flagged_records(product):
            flagged += 1
            log.warning(
                "%s %s (sku=%s) is out of stock but still purchasable.",
                kind, record_id, sku,
            )
            if kind == "product" and record_id in CONFIRMED_PRODUCT_IDS:
                log.info(
                    "Product %s is confirmed. %s",
                    record_id, "would disable" if DRY_RUN else "disabling",
                )
                if not DRY_RUN:
                    disable_confirmed_product(record_id)
                corrected += 1
    log.info(
        "Done. %d record(s) flagged, %d confirmed product(s) %s.",
        flagged, corrected, "to correct" if DRY_RUN else "corrected",
    )


if __name__ == "__main__":
    run()
