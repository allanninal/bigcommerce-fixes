"""Find BigCommerce promotions where group_ids and excluded_group_ids both fire.

A promotion's customer eligibility object can carry both group_ids (an allow-list
of customer group IDs) and excluded_group_ids (a deny-list). The Promotions API
accepts and stores this combination without a validation error, because it only
checks the shape of the request, not the business logic of the rule. BigCommerce's
own docs say only one of the two fields should be populated at a time. When both
are non-empty, the promotion engine's eligibility check has no defined precedence
between "must be in these groups" and "must not be in these groups," so it fails
closed and the promotion never triggers at checkout for any shopper, even ones who
satisfy group_ids. This job lists every ENABLED promotion, flags the ones with a
conflicting allow-list and deny-list at the top level or inside any rule, and only
ever reports the conflict with a suggested fix, unless explicitly told to apply the
opt-in clear-excluded-group-ids remediation. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/promotion-group-exclusion-conflict/
"""
import os
import sys
import logging
from typing import Optional, TypedDict

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_group_conflicts")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
APPLY_CLEAR_EXCLUDED = "--apply-clear-excluded" in sys.argv

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


class GroupConflictResult(TypedDict):
    conflict: bool
    reason: str
    suggested_fix: Optional[dict]


def decide_group_conflict(group_ids: list, excluded_group_ids: list) -> GroupConflictResult:
    """Pure decision. No network, no side effects.

    Both empty, or only one of the two lists populated: no conflict (a valid,
    unambiguous eligibility rule, including the valid all-customers case).
    Both non-empty, including the group_id 0 guest sentinel appearing in either
    list: conflict, with a default suggested fix of clearing excluded_group_ids
    to keep the narrower, more deliberate allow-list.
    """
    if group_ids and excluded_group_ids:
        return {
            "conflict": True,
            "reason": "both group_ids and excluded_group_ids populated",
            "suggested_fix": {"clear": "excluded_group_ids"},
        }
    return {
        "conflict": False,
        "reason": "at most one of the two lists is populated",
        "suggested_fix": None,
    }


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def enabled_promotions():
    """Page through every ENABLED promotion via the {data, meta} envelope."""
    params = {"status": "ENABLED", "limit": 250}
    path = "/promotions"
    while path:
        payload = bc_get(path, params if path == "/promotions" else None)
        for promo in payload.get("data", []):
            yield promo
        next_url = (
            payload.get("meta", {}).get("pagination", {}).get("links", {}).get("next")
        )
        path = next_url.replace(API_BASE, "") if next_url else None
        params = None


def eligibility_pairs(promotion):
    """Yield (scope_label, group_ids, excluded_group_ids) for top level and each rule."""
    customer = promotion.get("customer") or {}
    yield ("top_level", customer.get("group_ids") or [], customer.get("excluded_group_ids") or [])
    for i, rule in enumerate(promotion.get("rules") or []):
        rule_customer = rule.get("customer") or {}
        if rule_customer:
            yield (
                f"rules[{i}]",
                rule_customer.get("group_ids") or [],
                rule_customer.get("excluded_group_ids") or [],
            )


def apply_clear_excluded(promotion):
    """Opt-in remediation. Clears excluded_group_ids at the top level only,
    then re-fetches to confirm only one array is populated before returning."""
    promo_id = promotion["id"]
    customer = dict(promotion.get("customer") or {})
    customer["excluded_group_ids"] = []
    bc_put(f"/promotions/{promo_id}", {"customer": customer})

    refreshed = bc_get(f"/promotions/{promo_id}")
    data = refreshed.get("data", refreshed)
    fixed_customer = data.get("customer") or {}
    still_conflicting = decide_group_conflict(
        fixed_customer.get("group_ids") or [], fixed_customer.get("excluded_group_ids") or []
    )["conflict"]
    return not still_conflicting


def run():
    flagged = 0
    resolved = 0

    for promo in enabled_promotions():
        for scope, group_ids, excluded_group_ids in eligibility_pairs(promo):
            result = decide_group_conflict(group_ids, excluded_group_ids)
            if not result["conflict"]:
                continue

            flagged += 1
            log.warning(
                "CONFLICT id=%s name=%r scope=%s group_ids=%s excluded_group_ids=%s "
                "suggested_fix=%s",
                promo["id"], promo.get("name"), scope, group_ids, excluded_group_ids,
                result["suggested_fix"],
            )

            if scope == "top_level" and not DRY_RUN and APPLY_CLEAR_EXCLUDED:
                ok = apply_clear_excluded(promo)
                if ok:
                    resolved += 1
                    log.info("RESOLVED id=%s cleared excluded_group_ids", promo["id"])
                else:
                    log.error("STILL CONFLICTING id=%s after apply, needs manual review", promo["id"])

    log.info(
        "Done. %d conflict(s) flagged, %d resolved.",
        flagged, resolved,
    )


if __name__ == "__main__":
    run()
