"""Consolidate duplicate BigCommerce customer records onto one canonical customer_id.

BigCommerce creates a fully independent customer record for guest checkout,
storefront registration, and admin-panel entry, and treats each customer_id as
its own entity with orders owned through order.customer_id and addresses owned
through address.customer_id. There is no merge or alias relationship in the
data model, and the REST Management API only exposes CRUD on individual
resources, never a bulk reassign-all-child-resources call, so BigCommerce never
shipped a merge endpoint. This job clusters customers by normalized email,
picks a canonical customer_id per cluster, reassigns every order from the
duplicate to the canonical id, recreates any address on the canonical id that
does not already exist there, and flags the duplicate customer_id for human
confirmation. It never deletes a customer record on its own. Safe to run again
and again.

Guide: https://www.allanninal.dev/bigcommerce/no-customer-merge-endpoint/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("merge_duplicate_customers")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(base, path, params=None):
    r = requests.get(f"{base}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_put(base, path, body):
    r = requests.put(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_post(base, path, body):
    r = requests.post(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def _address_key(address):
    return (
        (address.get("address1") or "").strip().lower(),
        (address.get("postal_code") or "").strip().lower(),
        (address.get("city") or "").strip().lower(),
    )


def plan_customer_merge(canonical, duplicate):
    """Pure decision. No network, no side effects.

    Every order id under duplicate["orders"] is added to ordersToReassign,
    regardless of status_id, so refunded and cancelled orders are preserved.
    Each duplicate address is compared to the canonical customer's addresses
    by a normalized (address1, postal_code, city) key: a match is skipped,
    anything else is queued to be recreated. duplicateCustomerIdToDeactivate
    is always duplicate["id"], asserted to never equal canonical["id"].

    canonical: {"id": number, "addresses": [Address, ...]}
    duplicate: {"id": number, "orders": [{"id": number, ...}, ...], "addresses": [Address, ...]}

    Returns:
        {
            "ordersToReassign": [order_id, ...],
            "addressesToCreate": [Address, ...],
            "addressesToSkip": [address_id, ...],
            "duplicateCustomerIdToDeactivate": number,
        }
    """
    canonical_keys = {_address_key(a) for a in canonical.get("addresses", [])}

    orders_to_reassign = [o["id"] for o in duplicate.get("orders", [])]

    addresses_to_create = []
    addresses_to_skip = []
    for address in duplicate.get("addresses", []):
        if _address_key(address) in canonical_keys:
            addresses_to_skip.append(address["id"])
        else:
            addresses_to_create.append(address)

    duplicate_customer_id_to_deactivate = duplicate["id"]
    assert duplicate_customer_id_to_deactivate != canonical["id"], (
        "duplicate customer_id must never equal canonical customer_id"
    )

    return {
        "ordersToReassign": orders_to_reassign,
        "addressesToCreate": addresses_to_create,
        "addressesToSkip": addresses_to_skip,
        "duplicateCustomerIdToDeactivate": duplicate_customer_id_to_deactivate,
    }


def all_customers():
    """Page through every customer via GET /v3/customers."""
    page = 1
    while True:
        resp = bc_get(API_BASE_V3, "/customers", {"limit": 250, "page": page})
        rows = resp.get("data", [])
        if not rows:
            return
        for row in rows:
            yield row
        page += 1


def cluster_by_email(customers):
    """Group customer records that share a normalized (lowercased) email."""
    clusters = {}
    for c in customers:
        key = (c.get("email") or "").strip().lower()
        if not key:
            continue
        clusters.setdefault(key, []).append(c)
    return {k: v for k, v in clusters.items() if len(v) > 1}


def customer_orders(customer_id):
    """All orders for a customer_id, every status_id, via GET /v2/orders."""
    orders = []
    page = 1
    while True:
        rows = bc_get(API_BASE_V2, "/orders", {"customer_id": customer_id, "limit": 250, "page": page})
        if not rows:
            return orders
        orders.extend(rows)
        page += 1


def customer_addresses(customer_id):
    """All stored addresses for a customer_id via GET /v3/customers/addresses."""
    resp = bc_get(API_BASE_V3, "/customers/addresses", {"customer_id:in": customer_id})
    return resp.get("data", [])


def reassign_order(order_id, canonical_id):
    """PUT /v2/orders/{order_id} with only customer_id (partial update)."""
    return bc_put(API_BASE_V2, f"/orders/{order_id}", {"customer_id": canonical_id})


def create_address(canonical_id, address):
    """POST /v3/customers/addresses to recreate an address on the canonical id."""
    payload = [{
        "customer_id": canonical_id,
        "first_name": address.get("first_name", ""),
        "last_name": address.get("last_name", ""),
        "address1": address.get("address1", ""),
        "city": address.get("city", ""),
        "state_or_province": address.get("state_or_province", ""),
        "postal_code": address.get("postal_code", ""),
        "country_code": address.get("country_code", ""),
    }]
    return bc_post(API_BASE_V3, "/customers/addresses", payload)


def pick_canonical(cluster):
    """Canonical = lowest customer_id in the cluster."""
    return sorted(cluster, key=lambda c: c.get("id"))[0]


def run():
    customers = list(all_customers())
    clusters = cluster_by_email(customers)

    merged = 0
    flagged = 0

    for email, members in clusters.items():
        canonical_record = pick_canonical(members)
        canonical_id = canonical_record["id"]
        canonical = {"id": canonical_id, "addresses": customer_addresses(canonical_id)}

        for member in members:
            if member["id"] == canonical_id:
                continue

            duplicate = {
                "id": member["id"],
                "orders": customer_orders(member["id"]),
                "addresses": customer_addresses(member["id"]),
            }

            plan = plan_customer_merge(canonical, duplicate)

            log.info(
                "email=%s canonical_id=%s duplicate_id=%s orders_to_reassign=%s "
                "addresses_to_create=%d addresses_to_skip=%s (%s)",
                email, canonical_id, plan["duplicateCustomerIdToDeactivate"],
                plan["ordersToReassign"], len(plan["addressesToCreate"]),
                plan["addressesToSkip"], "dry run" if DRY_RUN else "applying",
            )

            if not DRY_RUN:
                for order_id in plan["ordersToReassign"]:
                    reassign_order(order_id, canonical_id)
                for address in plan["addressesToCreate"]:
                    create_address(canonical_id, address)

            log.warning(
                "Duplicate customer_id %s flagged for human confirmation before deletion.",
                plan["duplicateCustomerIdToDeactivate"],
            )
            merged += 1
            flagged += 1

    log.info(
        "Done. %d duplicate(s) %s, %d duplicate(s) flagged for review.",
        merged, "to merge" if DRY_RUN else "merged", flagged,
    )


if __name__ == "__main__":
    run()
