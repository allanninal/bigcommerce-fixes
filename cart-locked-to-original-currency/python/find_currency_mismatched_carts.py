"""Find and, when authorized, migrate BigCommerce carts locked to the wrong currency.

A BigCommerce cart's transactional currency is fixed at creation time and stored
on the cart object as cart.currency.code. The REST Cart API has no endpoint to
mutate the currency of an existing cart. When a shopper switches the storefront
currency selector after items are already in the cart, the storefront only
updates the display currency, a cookie or session preference, while the
underlying cart and checkout keep transacting in the original currency. This
job lists open carts, compares each cart's currency against the shopper's
selected currency (falling back to the store's default for untracked guest
carts), and flags every mismatch. Carts with a manual discount or draft-order
status are excluded from auto-migration and only ever reported, since
BigCommerce blocks or alters currency changes on those, and any promotion or
gift certificate invalid in the new currency is silently dropped when a new
cart is rebuilt. Eligible carts are proposed for a guarded migration to a new
cart in the correct currency, gated by DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/cart-locked-to-original-currency/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_currency_mismatched_carts")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CHANNEL_ID = int(os.environ.get("CHANNEL_ID", "1"))

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_delete(path):
    r = requests.delete(f"{API_BASE}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()


def _cart_has_line_items(cart: dict) -> bool:
    line_items = cart.get("line_items") or {}
    for key in ("physical_items", "digital_items", "gift_certificates", "custom_items"):
        if line_items.get(key):
            return True
    return False


def _cart_has_blocking_discount(cart: dict) -> bool:
    if cart.get("is_draft"):
        return True
    line_items = cart.get("line_items") or {}
    for key in ("physical_items", "digital_items", "custom_items"):
        for item in line_items.get(key) or []:
            if item.get("discounts"):
                return True
    return False


def find_currency_mismatched_carts(
    carts: list, selected_currency_by_customer: dict, store_default_currency: str
) -> list:
    """Pure decision logic. No network calls.

    carts: list of cart dicts as returned by GET /v3/carts/{cartId}, each with
    {"id": str, "customer_id": int|None, "currency": {"code": str},
    "line_items": {...}, "base_amount": float}.

    selected_currency_by_customer: map of customer_id (or session/guest id) to
    the shopper's currently selected storefront currency_code.

    store_default_currency: the store's active default currency_code, used as
    a fallback for guest carts with no tracked selection.

    Returns the subset of cart dicts (augmented with 'expected_currency' and
    'has_blocking_discount') whose cart.currency.code differs from the
    shopper's selected currency and that have at least one line item. Empty
    carts are never flagged.
    """
    flagged = []
    for cart in carts:
        if not _cart_has_line_items(cart):
            continue

        customer_id = cart.get("customer_id")
        key = str(customer_id) if customer_id else cart.get("id")
        expected_currency = selected_currency_by_customer.get(key, store_default_currency)
        if not expected_currency:
            continue

        cart_currency = (cart.get("currency") or {}).get("code")
        if cart_currency == expected_currency:
            continue

        flagged.append(
            {
                **cart,
                "expected_currency": expected_currency,
                "has_blocking_discount": _cart_has_blocking_discount(cart),
            }
        )
    return flagged


def get_store_default_currency():
    currencies = bc_get("/currencies").get("data") or []
    for currency in currencies:
        if currency.get("is_default"):
            return currency.get("currency_code")
    return None


def list_open_carts():
    resp = bc_get("/carts")
    return resp.get("data") or []


def build_migration_line_items(cart):
    line_items = cart.get("line_items") or {}
    return {
        "line_items": [
            {
                "product_id": item["product_id"],
                "variant_id": item.get("variant_id"),
                "quantity": item["quantity"],
            }
            for item in line_items.get("physical_items") or []
        ]
    }


def migrate_cart(cart, channel_id):
    body = {
        "channel_id": channel_id,
        "currency": {"code": cart["expected_currency"]},
        **build_migration_line_items(cart),
    }
    return bc_post("/carts", body)


def delete_cart(cart_id):
    bc_delete(f"/carts/{cart_id}")


def run(selected_currency_by_customer=None):
    selected_currency_by_customer = selected_currency_by_customer or {}
    store_default_currency = get_store_default_currency()
    carts = list_open_carts()

    mismatched = find_currency_mismatched_carts(carts, selected_currency_by_customer, store_default_currency)

    migrated = 0
    reported_only = 0

    for cart in mismatched:
        cart_id = cart["id"]
        log.info(
            "cart_id=%s customer_id=%s cart_currency=%s expected_currency=%s has_blocking_discount=%s",
            cart_id, cart.get("customer_id"), (cart.get("currency") or {}).get("code"),
            cart["expected_currency"], cart["has_blocking_discount"],
        )

        if cart["has_blocking_discount"]:
            log.warning("cart_id=%s excluded from auto-migration, reporting only.", cart_id)
            reported_only += 1
            continue

        if DRY_RUN:
            log.info("DRY_RUN: would create a replacement cart for cart_id=%s and delete the stale cart.", cart_id)
            migrated += 1
            continue

        new_cart = migrate_cart(cart, CHANNEL_ID)
        delete_cart(cart_id)
        new_cart_id = (new_cart.get("data") or {}).get("id")
        log.info("cart_id=%s migrated to new_cart_id=%s", cart_id, new_cart_id)
        migrated += 1

    log.info(
        "Done. %d cart(s) %s, %d cart(s) reported only (blocking discount).",
        migrated, "to migrate" if DRY_RUN else "migrated", reported_only,
    )


if __name__ == "__main__":
    run()
