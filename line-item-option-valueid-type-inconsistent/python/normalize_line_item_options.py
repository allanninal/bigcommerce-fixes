"""Normalize BigCommerce line item option valueId before building an order payload.

BigCommerce product options split into two families. Choice-based types
(dropdown, radio_buttons, rectangles, swatch, product_list, checkbox) resolve to
a catalog option_value record with a numeric id. Free-input types (text,
multi_line_text, numbers_only_text, date, file) have no option_values array at
all. The Checkout SDK's LineItemOption.valueId reflects that split literally:
numeric for choice options, null for free-input options, and across SDK/API
versions that numeric id is sometimes serialized as a string. A script that
forwards option.valueId straight into the v2 POST /v2/orders product_options
array (which expects {id, value}) breaks: null valueIds get sent as null or
omitted, and string-typed ids fail strict type validation, producing
"The options of one or more products are invalid." This script cross-references
each product's real option_values catalog via GET /v3/catalog/products/{id}/options
and /modifiers, walks open and abandoned carts, and reports every mismatch. It
never guesses a numeric id; anything unresolved is flagged, never auto-written.

Guide: https://www.allanninal.dev/bigcommerce/line-item-option-valueid-type-inconsistent/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("normalize_line_item_options")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FREE_INPUT_TYPES = {"text", "multi_line_text", "numbers_only_text", "date", "file"}
CHOICE_TYPES = {"dropdown", "radio_buttons", "rectangles", "swatch", "product_list", "checkbox"}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


class OptionValueUnresolvedError(ValueError):
    pass


def bc_get_v3(path, params=None):
    r = requests.get(f"{API_BASE_V3}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    body = r.json() if r.text else {}
    return body.get("data", [])


def product_option_values(product_id):
    """Map every choice-based option's id to its list of {id, label} option_values."""
    by_option_id = {}
    for endpoint in ("options", "modifiers"):
        for option in bc_get_v3(f"/catalog/products/{product_id}/{endpoint}"):
            values = option.get("option_values") or []
            by_option_id[option["id"]] = [
                {"id": v["id"], "label": v.get("label", "")} for v in values
            ]
    return by_option_id


def normalize_line_item_option_value(option, catalog_option_values):
    """Pure decision. No network, no side effects.

    option: {type, value, valueId, optionId, nameId}
    catalog_option_values: list of {id, label} for this option's choices.

    If option.type is free-input, or valueId is None, return the literal text
    passthrough: {id: option.optionId or option.nameId, value: str(option.value)}.
    Otherwise coerce valueId to a number and confirm it exists in
    catalog_option_values. If that fails, fall back to a label match on
    option.value. If nothing matches, raise OptionValueUnresolvedError rather
    than silently sending a bad id.
    """
    is_free_input = option.get("type") in FREE_INPUT_TYPES
    value_id = option.get("valueId")

    if is_free_input or value_id is None:
        return {
            "id": option.get("optionId") if option.get("optionId") is not None else option.get("nameId"),
            "value": str(option.get("value")),
        }

    try:
        numeric_id = int(value_id)
    except (TypeError, ValueError):
        numeric_id = None

    if numeric_id is not None:
        for entry in catalog_option_values:
            if entry["id"] == numeric_id:
                return {"id": numeric_id, "value": option.get("value")}

    label = option.get("value")
    for entry in catalog_option_values:
        if entry.get("label") == label:
            return {"id": entry["id"], "value": option.get("value")}

    raise OptionValueUnresolvedError(
        f"Could not resolve option value id for valueId={value_id!r} value={label!r}"
    )


def find_mismatches(cart_id, line_items, option_types_by_product):
    """Flag choice-based options whose valueId is null, empty, or non-numeric."""
    mismatches = []
    for item in line_items:
        product_id = item["product_id"]
        option_types = option_types_by_product.get(product_id, {})
        for option in item.get("options", []):
            option_type = option_types.get(option.get("nameId"), option.get("type"))
            value_id = option.get("valueId")
            is_choice = option_type in CHOICE_TYPES
            looks_numeric = isinstance(value_id, int) or (
                isinstance(value_id, str) and value_id.isdigit()
            )
            if is_choice and not looks_numeric:
                mismatches.append({
                    "cart_id": cart_id,
                    "product_id": product_id,
                    "option_id": option.get("nameId") or option.get("optionId"),
                    "option_type": option_type,
                    "raw_value_id_typeof": type(value_id).__name__,
                })
    return mismatches


def candidate_carts():
    """Page through open and abandoned carts."""
    page = 1
    while True:
        carts = bc_get_v3(
            "/carts",
            {"page": page, "limit": 50, "include": "line_items.physical_items.options,line_items.digital_items.options"},
        )
        if not carts:
            return
        for cart in carts:
            yield cart
        page += 1


def run():
    reported = 0
    resolved = 0
    unresolved = 0
    option_values_cache = {}

    for cart in candidate_carts():
        cart_id = cart["id"]
        line_items = (cart.get("line_items", {}).get("physical_items", []) or []) + (
            cart.get("line_items", {}).get("digital_items", []) or []
        )

        option_types_by_product = {}
        for item in line_items:
            product_id = item["product_id"]
            if product_id not in option_values_cache:
                option_values_cache[product_id] = product_option_values(product_id)
            option_types_by_product[product_id] = {
                oid: [] for oid in option_values_cache[product_id]
            }

        mismatches = find_mismatches(cart_id, line_items, option_types_by_product)
        for mismatch in mismatches:
            log.warning("Mismatch found: %s", mismatch)
            reported += 1

        for item in line_items:
            product_id = item["product_id"]
            catalog = option_values_cache.get(product_id, {})
            for option in item.get("options", []):
                option_id = option.get("nameId") or option.get("optionId")
                values_for_option = catalog.get(option_id, [])
                try:
                    normalized = normalize_line_item_option_value(option, values_for_option)
                    log.info(
                        "cart_id=%s option_id=%s before=%s after=%s (%s)",
                        cart_id, option_id, option.get("valueId"), normalized,
                        "dry run" if DRY_RUN else "resolved",
                    )
                    resolved += 1
                except OptionValueUnresolvedError as exc:
                    log.warning("cart_id=%s option_id=%s unresolved: %s", cart_id, option_id, exc)
                    unresolved += 1

    log.info(
        "Done. %d mismatch(es) reported, %d option(s) resolved, %d option(s) unresolved.",
        reported, resolved, unresolved,
    )


if __name__ == "__main__":
    run()
