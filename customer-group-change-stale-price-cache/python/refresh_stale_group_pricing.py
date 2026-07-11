"""Find and repair BigCommerce carts still quoting a stale customer-group price.

BigCommerce resolves customer-group pricing by joining the customer's
customer_group_id (a V2-only field, customer groups are "not yet available on
the V3 Customers API") to a price list through /v3/pricelists/assignments,
then reading /v3/pricelists/{id}/records for the variant. That resolution
happens once per cart or session and gets cached: an existing cart keeps the
price snapshot captured under the old group, storefront and CDN edge caching
can serve pre-rendered pricing for several minutes, and BigCommerce support
documentation itself warns pricing changes can take up to about 10 minutes to
propagate. So when an admin moves a customer between groups, the customer
record updates immediately but an already-created cart, an active browser
session, or an edge-cached page keeps quoting the old group's price list
until a new cart or session forces re-resolution.

This job audits a list of customer/cart pairs, reads the customer's current
group and the price list it maps to, compares that against each cart line
item's recorded price, and for a genuine mismatch forces that one cart to
re-resolve, either by resubmitting the line item quantity or deleting the
cart. It never rewrites the price list record itself, that would change
pricing for every customer in the group, not just fix the one stale cart.

Guide: https://www.allanninal.dev/bigcommerce/customer-group-change-stale-price-cache/
"""
import json
import logging
import os
from decimal import Decimal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("refresh_stale_group_pricing")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_ROOT = f"https://api.bigcommerce.com/stores/{STORE_HASH}"
CHANNEL_ID = os.environ.get("CHANNEL_ID", "1")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_ROOT}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_put(path, body):
    r = requests.put(f"{API_ROOT}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_delete(path):
    r = requests.delete(f"{API_ROOT}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()


def is_price_stale(cart_line_item: dict, price_list_record: dict, tolerance: Decimal = Decimal("0.01")) -> bool:
    """Pure decision. No network, no side effects.

    expected = price_list_record's sale_price if set, else its price.
    actual = cart_line_item's sale_price if set, else its list_price.
    Returns True when the two disagree by more than tolerance, meaning the
    cart is still quoting a price that does not match what the customer's
    current group and price list would produce right now.
    """
    expected = (
        price_list_record["sale_price"]
        if price_list_record.get("sale_price") is not None
        else price_list_record["price"]
    )
    actual = (
        cart_line_item["sale_price"]
        if cart_line_item.get("sale_price") is not None
        else cart_line_item["list_price"]
    )
    return abs(Decimal(str(expected)) - Decimal(str(actual))) > tolerance


def current_customer_group_id(customer_id):
    customer = bc_get(f"/v2/customers/{customer_id}")
    return customer.get("customer_group_id")


def price_list_id_for_group(customer_group_id, channel_id=CHANNEL_ID):
    resp = bc_get(
        "/v3/pricelists/assignments",
        {"customer_group_id": customer_group_id, "channel_id": channel_id},
    )
    assignments = resp.get("data") or []
    return assignments[0]["price_list_id"] if assignments else None


def get_cart(cart_id):
    return bc_get(f"/v3/carts/{cart_id}")


def price_list_record_for_variant(price_list_id, variant_id):
    resp = bc_get(f"/v3/pricelists/{price_list_id}/records", {"variant_id": variant_id})
    records = resp.get("data") or []
    return records[0] if records else None


def force_line_item_reresolve(cart_id, item_id, quantity):
    return bc_put(f"/v3/carts/{cart_id}/items/{item_id}", {"line_item": {"quantity": quantity}})


def force_cart_refresh_by_delete(cart_id):
    bc_delete(f"/v3/carts/{cart_id}")


def audit_targets():
    """Yields dicts describing which customer/cart pairs to check.

    In production this would come from an audit log of recent customer group
    changes (for example a webhook or a scheduled export). Kept as a small
    seam here so run() stays testable at the integration level too.
    Expected shape: {"customer_id": int, "cart_id": str, "old_group_id": int}
    """
    raw = os.environ.get("AUDIT_TARGETS_JSON", "[]")
    return json.loads(raw)


def run():
    checked = 0
    repaired = 0

    for target in audit_targets():
        customer_id = target["customer_id"]
        cart_id = target["cart_id"]
        old_group_id = target.get("old_group_id")

        new_group_id = current_customer_group_id(customer_id)
        price_list_id = price_list_id_for_group(new_group_id)
        if price_list_id is None:
            log.warning(
                "No price list assignment for customer %s group %s, skipping.",
                customer_id, new_group_id,
            )
            continue

        cart = get_cart(cart_id)
        line_items = (
            cart.get("data", {}).get("line_items", {}).get("physical_items", []) or []
        )

        for line_item in line_items:
            checked += 1
            record = price_list_record_for_variant(price_list_id, line_item["variant_id"])
            if record is None:
                continue

            if not is_price_stale(line_item, record):
                continue

            expected = record["sale_price"] if record.get("sale_price") is not None else record["price"]
            actual = line_item["sale_price"] if line_item.get("sale_price") is not None else line_item["list_price"]

            log.info(
                "cart_id=%s customer_id=%s old_group=%s new_group=%s cart_price=%s expected_price=%s (%s)",
                cart_id, customer_id, old_group_id, new_group_id, actual, expected,
                "dry run" if DRY_RUN else "repairing",
            )

            if not DRY_RUN:
                force_line_item_reresolve(cart_id, line_item["id"], line_item["quantity"])
            repaired += 1

    log.info(
        "Done. %d line item(s) checked, %d %s.",
        checked, repaired, "would be repaired" if DRY_RUN else "repaired",
    )


if __name__ == "__main__":
    run()
