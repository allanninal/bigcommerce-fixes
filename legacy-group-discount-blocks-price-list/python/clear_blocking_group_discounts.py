"""Clear legacy customer group discount_rules that are blocking a Price List.

BigCommerce customer groups support two mutually exclusive pricing mechanisms:
legacy discount_rules (store-wide, category, or product percent, fixed, or
price-modifier discounts, set through the V2 Customer Groups API) and V3 Price
List assignments. A group can only run one at a time. If discount_rules is
still non-empty on a group from before Price Lists were adopted, a Price List
assignment created with POST /v3/pricelists/assignments will not visibly apply
at storefront for that group, because the legacy discount takes precedence and
the group's pricing representation reverts to method/amount instead of
price_list_id. This job lists every customer group and every active price list
assignment, flags the groups where both a legacy discount and a price list are
configured at once, and clears the legacy discount_rules on those groups only,
leaving the price list assignment itself untouched. Safe to run again and
again.

Guide: https://www.allanninal.dev/bigcommerce/legacy-group-discount-blocks-price-list/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_blocking_group_discounts")

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


def bc_get_v2(path, params=None):
    r = requests.get(f"{API_BASE_V2}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else []


def bc_get_v3(path, params=None):
    r = requests.get(f"{API_BASE_V3}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {"data": [], "meta": {}}


def bc_put_v2(path, body):
    r = requests.put(f"{API_BASE_V2}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def find_blocked_price_list_groups(customer_groups, price_list_assignments):
    """Pure decision. No network, no side effects.

    customer_groups: V2 /v2/customer_groups records, each
        {"id": int, "name": str, "discount_rules": list, ...}
    price_list_assignments: V3 /v3/pricelists/assignments 'data' records, each
        {"price_list_id": int, "customer_group_id": int, "channel_id": int}

    A group is 'blocked' if it has a non-empty legacy discount_rules list AND
    it also appears as customer_group_id in at least one price_list_assignments
    entry. Returns one dict per blocked group: {group_id, group_name,
    discount_rules, price_list_ids}.
    """
    assigned_group_ids = {}
    for a in price_list_assignments:
        assigned_group_ids.setdefault(a["customer_group_id"], []).append(a["price_list_id"])

    blocked = []
    for g in customer_groups:
        rules = g.get("discount_rules") or []
        gid = g["id"]
        if rules and gid in assigned_group_ids:
            blocked.append({
                "group_id": gid,
                "group_name": g.get("name"),
                "discount_rules": rules,
                "price_list_ids": assigned_group_ids[gid],
            })
    return blocked


def all_customer_groups():
    groups = []
    page = 1
    while True:
        batch = bc_get_v2("/customer_groups", {"page": page, "limit": 250})
        if not batch:
            return groups
        groups.extend(batch)
        page += 1


def all_price_list_assignments():
    assignments = []
    page = 1
    while True:
        result = bc_get_v3("/pricelists/assignments", {"page": page, "limit": 250})
        data = result.get("data") or []
        if not data:
            return assignments
        assignments.extend(data)
        page += 1


def clear_discount_rules(group_id):
    return bc_put_v2(f"/customer_groups/{group_id}", {"discount_rules": []})


def confirm_cleared(group_id):
    group = bc_get_v2(f"/customer_groups/{group_id}")
    rules = group.get("discount_rules") or []
    return len(rules) == 0


def run():
    groups = all_customer_groups()
    assignments = all_price_list_assignments()
    blocked = find_blocked_price_list_groups(groups, assignments)

    log.info("Found %d group(s) with a legacy discount blocking a price list.", len(blocked))

    cleared = 0
    for entry in blocked:
        log.info(
            "group_id=%s group_name=%s discount_rules=%s price_list_ids=%s (%s)",
            entry["group_id"], entry["group_name"], entry["discount_rules"],
            entry["price_list_ids"], "dry run" if DRY_RUN else "clearing",
        )
        if not DRY_RUN:
            clear_discount_rules(entry["group_id"])
            ok = confirm_cleared(entry["group_id"])
            if not ok:
                log.warning("group_id=%s did not confirm empty discount_rules after PUT.", entry["group_id"])
            cleared += 1

    log.info(
        "Done. %d group(s) %s.",
        len(blocked), "to clear" if DRY_RUN else f"cleared ({cleared} confirmed attempted)",
    )


if __name__ == "__main__":
    run()
