"""Find and safely repair BigCommerce customers stuck in the wrong customer group.

BigCommerce's native storefront only supports one global default customer group
at registration. It has no built-in conditional logic to route a signup into a
different group by email domain, order history, or a form answer. Merchants get
that conditional assignment from a custom script, a webhook, or a third-party
app that reads signup or order data and writes customer_group_id after the fact,
and when that rule has a bug, stale criteria, or races the platform's own
default-group assignment, the customer is left in the wrong group and sees the
wrong price, since a Price List or discount rule resolves off customer_group_id.

This lists customers, computes the expected group for each one from a rule you
define with a pure function, diffs it against the actual customer_group_id, and
reassigns the mismatched ones with a single PUT, re-reading the customer to
confirm the write persisted. It never touches order history, since BigCommerce
does not recompute a past order's price when the group changes. Guarded by
DRY_RUN. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/customer-group-mis-assigned/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_customer_group")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Define your own rule here. This example targets a wholesale group by email domain.
REASSIGNMENT_RULE = {
    "matchType": os.environ.get("RULE_MATCH_TYPE", "email_domain"),
    "pattern": os.environ.get("RULE_PATTERN", "wholesale-buyer.example"),
    "thresholdCents": int(os.environ.get("RULE_THRESHOLD_CENTS", "500000")),
    "targetGroupId": int(os.environ.get("RULE_TARGET_GROUP_ID", "3")),
    "fallbackGroupId": int(os.environ.get("RULE_FALLBACK_GROUP_ID", "0")),
}


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


def decide_group_reassignment(customer, rule):
    """Pure decision. No network calls.

    customer: {id, customer_group_id, email, tax_exempt_category?,
               total_lifetime_spend_cents?, registration_source?}
    rule: {matchType, pattern?, thresholdCents?, targetGroupId, fallbackGroupId}

    Returns {customerId, currentGroupId, expectedGroupId, needsReassignment, reason}.
    """
    match_type = rule["matchType"]
    target_id = rule["targetGroupId"]
    fallback_id = rule["fallbackGroupId"]
    current_id = customer.get("customer_group_id")

    if match_type == "email_domain":
        domain = (customer.get("email") or "").split("@")[-1].lower()
        expected_id = target_id if domain == (rule.get("pattern") or "").lower() else fallback_id
        reason = f"email domain {domain!r} matches {rule.get('pattern')!r}" if expected_id == target_id \
            else f"email domain {domain!r} does not match {rule.get('pattern')!r}"
    elif match_type == "spend_threshold":
        spend = customer.get("total_lifetime_spend_cents")
        threshold = rule["thresholdCents"]
        expected_id = target_id if (spend or 0) >= threshold else fallback_id
        reason = f"lifetime spend {spend!r} vs threshold {threshold}"
    elif match_type == "tax_exempt":
        expected_id = target_id if customer.get("tax_exempt_category") else fallback_id
        reason = f"tax_exempt_category={customer.get('tax_exempt_category')!r}"
    elif match_type == "source_tag":
        expected_id = target_id if customer.get("registration_source") == rule.get("pattern") else fallback_id
        reason = f"registration_source={customer.get('registration_source')!r} vs {rule.get('pattern')!r}"
    else:
        expected_id = fallback_id
        reason = f"unknown matchType {match_type!r}, defaulting to fallback"

    needs = expected_id != current_id
    if needs:
        reason = f"{reason}; expected group {expected_id} but customer is in group {current_id}"
    else:
        reason = f"{reason}; already in the correct group {current_id}"

    return {
        "customerId": customer["id"],
        "currentGroupId": current_id,
        "expectedGroupId": expected_id,
        "needsReassignment": needs,
        "reason": reason,
    }


def customer_groups():
    return bc("GET", "/v2/customer_groups") or []


def all_customers():
    page = 1
    while True:
        result = bc("GET", f"/v3/customers?limit=250&page={page}")
        if not result:
            return
        for customer in result:
            yield customer
        if len(result) < 250:
            return
        page += 1


def group_name(groups, group_id):
    match = next((g for g in groups if g["id"] == group_id), None)
    return match["name"] if match else f"group {group_id}"


def reassign_group(customer_id, expected_group_id):
    payload = [{"id": customer_id, "customer_group_id": expected_group_id}]
    result = bc("PUT", "/v3/customers", json=payload)
    updated = result[0] if isinstance(result, list) else result
    if updated.get("customer_group_id") != expected_group_id:
        raise RuntimeError(f"customer {customer_id} did not update to group {expected_group_id}")
    confirm = bc("GET", f"/v3/customers/{customer_id}")
    confirmed = confirm[0] if isinstance(confirm, list) else confirm
    if confirmed.get("customer_group_id") != expected_group_id:
        raise RuntimeError(f"customer {customer_id} group did not persist as {expected_group_id}")
    return confirmed


def run():
    reassigned = 0
    checked = 0
    groups = customer_groups()

    for customer in all_customers():
        checked += 1
        decision = decide_group_reassignment(customer, REASSIGNMENT_RULE)
        if not decision["needsReassignment"]:
            continue

        log.warning(
            "Customer %s: %s -> %s (%s). %s",
            decision["customerId"],
            group_name(groups, decision["currentGroupId"]),
            group_name(groups, decision["expectedGroupId"]),
            decision["reason"],
            "would reassign" if DRY_RUN else "reassigning",
        )
        if not DRY_RUN:
            reassign_group(decision["customerId"], decision["expectedGroupId"])
        reassigned += 1

    log.info(
        "Done. Checked %d customer(s). %d %s.",
        checked, reassigned, "to reassign" if DRY_RUN else "reassigned",
    )


if __name__ == "__main__":
    run()
