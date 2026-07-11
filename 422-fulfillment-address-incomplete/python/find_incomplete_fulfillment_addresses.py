"""Find BigCommerce orders and checkouts whose fulfillment address looks
complete but is missing a subfield that trips 422 "A fulfillment address for
this order is incomplete" at order-creation or checkout-complete time.

POST /v3/checkouts/{checkoutId}/consignments only strictly requires email and
country_code on the address plus lineItems, so a consignment can be created
successfully with a partial address. POST /v3/orders and checkout complete
validate a fuller set of subfields: first_name, last_name, address1, city,
state_or_province_code, postal_code, country_code, phone. The missing key,
commonly state_or_province_code, postal_code, or phone, or an invalid
country_code/country_iso2, is easy to miss because the address object itself
is present. This job lists candidate orders (status_id 0 or 11), fetches each
stored shipping address, and reports the exact missing or invalid field per
order id. It never invents a value; a missing subfield is customer data this
script cannot safely guess. Only a narrow, deterministic normalization (a
known-good country name to its country_code) is ever written, gated by
DRY_RUN. Run on demand or on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/422-fulfillment-address-incomplete/
"""
import os
import re
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_incomplete_fulfillment_addresses")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
ORDER_STATUS_IDS = [s.strip() for s in os.environ.get("ORDER_STATUS_IDS", "0,11").split(",") if s.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

REQUIRED_KEYS = [
    "first_name", "last_name", "address1", "city",
    "state_or_province_code", "postal_code", "country_code", "phone",
]

ALIASES = {
    "address1": ["address1", "street_1"],
    "postal_code": ["postal_code", "zip"],
    "country_code": ["country_code", "country_iso2"],
    "state_or_province_code": ["state_or_province_code", "state_or_province", "state"],
}

COUNTRY_CODE_RE = re.compile(r"^[A-Za-z]{2}$")

# Narrow, deterministic country-name to country_code table. Extend only with
# values you have already validated; anything not in here stays flagged.
KNOWN_COUNTRY_MAP = {
    "united states": "US",
    "united states of america": "US",
    "canada": "CA",
    "united kingdom": "GB",
    "australia": "AU",
}


def bc_get(base, path, params=None):
    r = requests.get(f"{base}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(base, path, body):
    r = requests.put(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def _first_present(address, key):
    for alias in ALIASES.get(key, [key]):
        value = address.get(alias)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return None


def find_missing_address_fields(address, required_keys=None):
    """Pure decision. No network, no side effects.

    For each key in required_keys (accepting known aliases), check that the
    address has a non-empty value under that key or one of its aliases.
    country_code/country_iso2 is additionally checked against a 2-letter
    alpha pattern. Returns the ordered list of the first failing key(s), so
    the caller can log exactly which subfield would trigger BigCommerce's
    422, given no network calls, just the dict and the required-key table.
    """
    required_keys = required_keys or REQUIRED_KEYS
    address = address or {}
    missing = []
    for key in required_keys:
        value = _first_present(address, key)
        if value is None:
            missing.append(key)
            continue
        if key == "country_code" and not COUNTRY_CODE_RE.match(value):
            missing.append(key)
    return missing


def candidate_orders():
    """Page through orders at the configured status_ids (default Incomplete, Awaiting Fulfillment)."""
    page = 1
    while True:
        found_any = False
        for status_id in ORDER_STATUS_IDS:
            orders = bc_get(API_BASE_V2, "/orders", {"status_id": status_id, "page": page, "limit": 50})
            for order in orders:
                found_any = True
                yield order
        if not found_any:
            return
        page += 1


def order_shipping_addresses(order_id):
    return bc_get(API_BASE_V2, f"/orders/{order_id}/shippingaddresses")


def normalize_country_code(order_id, address_id, address):
    """Only writes when the correct country_code can be deterministically
    derived from a validated country name. Everything else stays flagged."""
    country_name = (address.get("country") or "").strip().lower()
    derived = KNOWN_COUNTRY_MAP.get(country_name)
    if not derived:
        return None

    before = {"country_code": address.get("country_iso2") or address.get("country_code")}
    after = {"country_code": derived}
    if DRY_RUN:
        return {"order_id": order_id, "dry_run": True, "before": before, "after": after}

    bc_put(API_BASE_V2, f"/orders/{order_id}/shippingaddresses/{address_id}", after)
    return {"order_id": order_id, "dry_run": False, "before": before, "after": after}


def run():
    flagged = 0
    clean = 0

    for order in candidate_orders():
        order_id = order["id"]
        addresses = order_shipping_addresses(order_id)

        for address in addresses or []:
            missing = find_missing_address_fields(address)
            if not missing:
                clean += 1
                continue

            flagged += 1
            log.warning(
                "order_id=%s address_id=%s missing_or_invalid_fields=%s address_snapshot=%s",
                order_id, address.get("id"), missing,
                {k: address.get(k) for k in ("first_name", "last_name", "street_1", "city",
                                              "state", "zip", "country", "country_iso2", "phone")},
            )

            if "country_code" in missing:
                result = normalize_country_code(order_id, address.get("id"), address)
                if result:
                    log.info("country_code normalization: %s", result)

    log.info("Done. %d address(es) flagged, %d address(es) already complete.", flagged, clean)


if __name__ == "__main__":
    run()
