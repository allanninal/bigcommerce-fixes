"""Find and safely merge duplicate BigCommerce customers that share one email.

BigCommerce enforces email uniqueness only within the customer record created
through a single path at a time: guest checkout (which stores the email on
order.billing_address and leaves order.customer_id at 0, meaning no customer
record exists), storefront self-registration, admin-panel manual creation, and
V3 Customers API upserts. Nothing reconciles a guest order to a later account,
and nothing merges two customer objects that share an email. The result is
order history split across customer_id 0 and one or more real customer ids.

This pulls every customer with GET /v3/customers, pulls every orphaned guest
order with GET /v2/orders?customer_id=0, groups customers by normalized email
with a pure function, picks the earliest account per cluster as the survivor,
reassigns every matching order (including guest orders) onto the survivor with
PUT /v2/orders/{id}, confirms the loser has zero orders left, then deletes the
duplicate with DELETE /v3/customers?id:in={id}. Every write is guarded by
DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/duplicate-customers-for-one-email/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("merge_duplicate_customers")

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


def _normalize_email(email):
    return (email or "").strip().lower()


def plan_customer_merge(customers, orders):
    """customers: [{id, email, date_created}], orders: [{id, customer_id, billing_email}]
    -> [{survivorId, reassignOrderIds, deleteCustomerIds}]. Pure, no I/O.

    Groups customers by normalized email (trim + lowercase). Groups of size 1
    produce no plan. For groups of size > 1, the survivor is the customer with
    the earliest date_created, tie-broken by the lowest id. Then it scans
    orders for any order whose customer_id is 0 or a non-surviving id in the
    group, and whose normalized billing_email matches the group's email,
    collecting those order ids to reassign. deleteCustomerIds is every id in
    the group except the survivor. Never fuzzy-matches names, since only an
    exact normalized email match is safe to act on.
    """
    groups = {}
    for customer in customers:
        key = _normalize_email(customer["email"])
        if not key:
            continue
        groups.setdefault(key, []).append(customer)

    plans = []
    for email, group in groups.items():
        if len(group) < 2:
            continue
        survivor = min(group, key=lambda c: (c["date_created"], c["id"]))
        losing_ids = {c["id"] for c in group if c["id"] != survivor["id"]}

        reassign_order_ids = []
        for order in orders:
            if _normalize_email(order.get("billing_email")) != email:
                continue
            if order["customer_id"] == 0 or order["customer_id"] in losing_ids:
                reassign_order_ids.append(order["id"])

        plans.append({
            "survivorId": survivor["id"],
            "reassignOrderIds": sorted(reassign_order_ids),
            "deleteCustomerIds": sorted(losing_ids),
        })

    plans.sort(key=lambda p: p["survivorId"])
    return plans


def all_customers():
    """Yield every customer, paginated with meta.pagination.total_pages."""
    page = 1
    while True:
        res = requests.get(
            BASE + "v3/customers",
            params={"limit": 250, "page": page},
            headers={"X-Auth-Token": TOKEN, "Accept": "application/json"},
            timeout=30,
        )
        res.raise_for_status()
        body = res.json()
        for row in body["data"]:
            yield {"id": row["id"], "email": row["email"], "date_created": row["date_created"]}
        if page >= body["meta"]["pagination"]["total_pages"]:
            return
        page += 1


def guest_orders():
    """Yield every order with customer_id 0, paginated."""
    page = 1
    while True:
        batch = bc("GET", f"/v2/orders?customer_id=0&limit=250&page={page}")
        if not batch:
            return
        for order in batch:
            yield {
                "id": order["id"],
                "customer_id": order.get("customer_id", 0),
                "billing_email": (order.get("billing_address") or {}).get("email", ""),
            }
        if len(batch) < 250:
            return
        page += 1


def reassign_order(order_id, survivor_id):
    return bc("PUT", f"/v2/orders/{order_id}", json={"customer_id": survivor_id})


def loser_orders_remaining(loser_id):
    remaining = bc("GET", f"/v2/orders?customer_id={loser_id}&limit=1")
    return len(remaining or [])


def delete_customer(customer_id):
    return bc("DELETE", f"/v3/customers?id:in={customer_id}")


def run():
    customers = list(all_customers())
    orders = list(guest_orders())

    plans = plan_customer_merge(customers, orders)

    merged = 0
    for plan in plans:
        log.warning(
            "Cluster survivor=%s reassign=%s delete=%s. %s",
            plan["survivorId"], plan["reassignOrderIds"], plan["deleteCustomerIds"],
            "would merge" if DRY_RUN else "merging",
        )
        if DRY_RUN:
            merged += 1
            continue

        for order_id in plan["reassignOrderIds"]:
            reassign_order(order_id, plan["survivorId"])

        for loser_id in plan["deleteCustomerIds"]:
            if loser_orders_remaining(loser_id) > 0:
                log.error("Skipping delete of %s, orders still remain.", loser_id)
                continue
            delete_customer(loser_id)

        merged += 1

    log.info("Done. %d cluster(s) %s.", merged, "to merge" if DRY_RUN else "merged")


if __name__ == "__main__":
    run()
