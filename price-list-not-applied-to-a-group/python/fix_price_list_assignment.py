"""Find and safely repair BigCommerce customer groups whose price list is not applied.

A Price List by itself is only a container of custom prices. It has no effect on a
customer group until a Price List Assignment row links price_list_id and
customer_group_id, and optionally channel_id, through the V3 Price Lists
Assignments API. Building prices through a CSV import, migrating off the legacy
v2 group discount model, or adding a new sales channel commonly leaves that row
missing or scoped to the wrong channel, and the group silently falls back to
default catalog pricing with no error surfaced anywhere.

This checks every customer group that has active customers, resolves the price
list, and decides with a pure function whether to create a missing assignment,
fix one scoped to a channel the group's customers do not use, or flag the price
list when it is correctly assigned but missing records for the variants being
bought. Guarded by DRY_RUN. Never writes a price. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/price-list-not-applied-to-a-group/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_price_list_assignment")

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


def decide_reassignment(group, price_list, assignments, active_channel_ids,
                         variant_ids_needing_price, existing_record_variant_ids):
    """Pure decision. No network calls.

    group: {"id": int, "name": str}
    price_list: {"id": int, "active": bool} | None
    assignments: [{"id", "price_list_id", "customer_group_id", "channel_id"}]
    active_channel_ids: [int]
    variant_ids_needing_price: [int]
    existing_record_variant_ids: [int]

    Returns one of:
      {"action": "NONE"}
      {"action": "CREATE_ASSIGNMENT", "priceListId", "customerGroupId", "channelId"}
      {"action": "FIX_CHANNEL", "assignmentId", "fromChannelId", "toChannelId"}
      {"action": "FLAG_MISSING_RECORDS", "priceListId", "missingVariantIds"}
    """
    if not price_list or not price_list.get("active"):
        return {"action": "NONE"}

    group_assignments = [
        a for a in assignments
        if a["price_list_id"] == price_list["id"] and a["customer_group_id"] == group["id"]
    ]

    if not group_assignments:
        channel_id = active_channel_ids[0]
        return {
            "action": "CREATE_ASSIGNMENT",
            "priceListId": price_list["id"],
            "customerGroupId": group["id"],
            "channelId": channel_id,
        }

    mismatched = next((a for a in group_assignments if a["channel_id"] not in active_channel_ids), None)
    if mismatched:
        return {
            "action": "FIX_CHANNEL",
            "assignmentId": mismatched["id"],
            "fromChannelId": mismatched["channel_id"],
            "toChannelId": active_channel_ids[0],
        }

    missing = [v for v in variant_ids_needing_price if v not in existing_record_variant_ids]
    if missing:
        return {"action": "FLAG_MISSING_RECORDS", "priceListId": price_list["id"], "missingVariantIds": missing}

    return {"action": "NONE"}


def customer_groups():
    return bc("GET", "/v2/customer_groups") or []


def groups_with_customers(group_ids):
    ids = ",".join(str(g) for g in group_ids)
    counts = {}
    page = 1
    while True:
        result = bc("GET", f"/v3/customers?customer_group_id=in:{ids}&limit=250&page={page}")
        if not result:
            return counts
        for customer in result:
            gid = customer.get("customer_group_id")
            counts[gid] = counts.get(gid, 0) + 1
        if len(result) < 250:
            return counts
        page += 1


def price_lists():
    return bc("GET", "/v3/pricelists?limit=250") or []


def price_list_assignments(customer_group_id):
    return bc("GET", f"/v3/pricelists/assignments?customer_group_id={customer_group_id}") or []


def price_list_records(price_list_id):
    return bc("GET", f"/v3/pricelists/{price_list_id}/records?limit=250") or []


def active_channel_ids():
    channels = bc("GET", "/v3/channels?available=true") or []
    return [c["id"] for c in channels]


def create_assignment(price_list_id, customer_group_id, channel_id):
    payload = [{"price_list_id": price_list_id, "customer_group_id": customer_group_id, "channel_id": channel_id}]
    return bc("POST", "/v3/pricelists/assignments", json=payload)


def delete_assignment(price_list_id, customer_group_id, channel_id):
    path = (
        f"/v3/pricelists/assignments?price_list_id={price_list_id}"
        f"&customer_group_id={customer_group_id}&channel_id={channel_id}"
    )
    return bc("DELETE", path)


def run():
    created = 0
    fixed = 0
    flagged = 0

    groups = customer_groups()
    group_ids = [g["id"] for g in groups]
    active_counts = groups_with_customers(group_ids) if group_ids else {}
    lists = price_lists()
    channel_ids = active_channel_ids()

    for group in groups:
        if not active_counts.get(group["id"]):
            continue

        price_list = next((pl for pl in lists if pl.get("active")), None)
        assignments = price_list_assignments(group["id"])
        variant_ids_needing_price = []
        existing_record_variant_ids = []
        if price_list:
            records = price_list_records(price_list["id"])
            existing_record_variant_ids = [r["variant_id"] for r in records]

        decision = decide_reassignment(
            group, price_list, assignments, channel_ids,
            variant_ids_needing_price, existing_record_variant_ids,
        )

        if decision["action"] == "NONE":
            continue

        if decision["action"] == "CREATE_ASSIGNMENT":
            log.info(
                "Group %s missing assignment to price list %s. %s",
                group["name"], decision["priceListId"],
                "would create" if DRY_RUN else "creating",
            )
            if not DRY_RUN:
                create_assignment(decision["priceListId"], decision["customerGroupId"], decision["channelId"])
            created += 1

        elif decision["action"] == "FIX_CHANNEL":
            log.warning(
                "Group %s assignment %s scoped to channel %s, not an active channel. %s",
                group["name"], decision["assignmentId"], decision["fromChannelId"],
                "would fix" if DRY_RUN else "fixing",
            )
            if not DRY_RUN:
                delete_assignment(price_list["id"], group["id"], decision["fromChannelId"])
                create_assignment(price_list["id"], group["id"], decision["toChannelId"])
            fixed += 1

        elif decision["action"] == "FLAG_MISSING_RECORDS":
            log.warning(
                "Price list %s assigned to group %s but missing records for variants %s. Flagging for review.",
                decision["priceListId"], group["name"], decision["missingVariantIds"],
            )
            flagged += 1

    log.info(
        "Done. %d assignment(s) %s, %d channel fix(es) %s, %d price list(s) flagged for review.",
        created, "to create" if DRY_RUN else "created",
        fixed, "to apply" if DRY_RUN else "applied",
        flagged,
    )


if __name__ == "__main__":
    run()
