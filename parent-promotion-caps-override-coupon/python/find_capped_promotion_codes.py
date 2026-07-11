"""Find BigCommerce coupon codes silently gated by their parent promotion's cap.

In the Promotions v3 model, a coupon code is a child resource nested under a
parent Promotion (/v3/promotions/{promotionId}/codes/{codeId}), and both levels
carry independent max_uses/current_uses counters. BigCommerce enforces both at
checkout, and the promotion-level cap is the outer gate: even if a code's own
max_uses has plenty of headroom, the shopper gets "invalid coupon code" once the
parent promotion's aggregate current_uses reaches its max_uses. This job lists
every ENABLED promotion, pages its coupon codes, and flags any code where the
promotion is already exhausted or where the code's own remaining uses exceed
what the promotion has left. It never writes to a promotion's cap by default.
Raising a merchant's deliberate cap is a business decision, so a write only
happens behind an explicit --apply flag with DRY_RUN=false, and it always
prints the proposed diff first.

Guide: https://www.allanninal.dev/bigcommerce/parent-promotion-caps-override-coupon/
"""
import os
import sys
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_capped_promotion_codes")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get_page(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    body = r.json()
    return body.get("data", []), body.get("meta", {}).get("pagination", {})


def bc_get_all(path, params=None):
    page = 1
    items = []
    while True:
        data, pagination = bc_get_page(path, {**(params or {}), "page": page, "limit": 250})
        items.extend(data)
        total_pages = pagination.get("total_pages", 1)
        if page >= total_pages:
            return items
        page += 1


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def find_capped_out_codes(promotion: dict, codes: list) -> list:
    """Pure decision. No network, no side effects.

    promotion={id,max_uses,current_uses,status}
    codes=[{id,code,max_uses,current_uses}]

    promo_remaining = None if promotion["max_uses"] == 0 else
        max(promotion["max_uses"] - promotion["current_uses"], 0)
    code_remaining = None if code["max_uses"] == 0 else
        max(code["max_uses"] - code["current_uses"], 0)

    reason is "promotion_exhausted" if promo_remaining == 0,
    "promotion_cap_lower_than_code" if promo_remaining is not None and
        (code_remaining is None or code_remaining > promo_remaining),
    otherwise "ok".
    """
    promo_max = promotion.get("max_uses", 0) or 0
    promo_current = promotion.get("current_uses", 0) or 0
    promo_remaining = None if promo_max == 0 else max(promo_max - promo_current, 0)

    results = []
    for code in codes:
        code_max = code.get("max_uses", 0) or 0
        code_current = code.get("current_uses", 0) or 0
        code_remaining = None if code_max == 0 else max(code_max - code_current, 0)

        if promo_remaining == 0:
            reason = "promotion_exhausted"
        elif promo_remaining is not None and (
            code_remaining is None or code_remaining > promo_remaining
        ):
            reason = "promotion_cap_lower_than_code"
        else:
            reason = "ok"

        results.append({
            "code_id": code.get("id"),
            "code": code.get("code"),
            "reason": reason,
            "promotion_remaining": promo_remaining,
            "code_remaining": code_remaining,
        })
    return results


def enabled_coupon_promotions():
    promotions = bc_get_all("/promotions", {"status": "ENABLED"})
    return [p for p in promotions if "COUPON" in (p.get("redemption_type") or "")]


def promotion_codes(promotion_id):
    return bc_get_all(f"/promotions/{promotion_id}/codes")


def propose_raised_cap(promotion, target_max_uses):
    return {
        "promotion_id": promotion["id"],
        "from_max_uses": promotion.get("max_uses", 0),
        "to_max_uses": target_max_uses,
    }


def apply_raised_cap(promotion_id, target_max_uses):
    return bc_put(f"/promotions/{promotion_id}", {"max_uses": target_max_uses})


def run(apply_fix=False):
    flagged = 0
    checked = 0

    for promotion in enabled_coupon_promotions():
        codes = promotion_codes(promotion["id"])
        annotated = find_capped_out_codes(promotion, codes)
        checked += len(annotated)

        problem_codes = [c for c in annotated if c["reason"] != "ok"]
        if not problem_codes:
            continue

        max_code_max_uses = max((c.get("max_uses", 0) or 0) for c in codes) if codes else 0
        target_max_uses = max(max_code_max_uses, promotion.get("max_uses", 0) or 0)

        for c in problem_codes:
            log.warning(
                "promotion_id=%s promotion_name=%s code_id=%s code=%s reason=%s "
                "promotion_remaining=%s code_remaining=%s",
                promotion["id"], promotion.get("name"), c["code_id"], c["code"],
                c["reason"], c["promotion_remaining"], c["code_remaining"],
            )
            flagged += 1

        if apply_fix and target_max_uses != (promotion.get("max_uses", 0) or 0):
            diff = propose_raised_cap(promotion, target_max_uses)
            log.info("Proposed fix: %s (%s)", diff, "dry run" if DRY_RUN else "applying")
            if not DRY_RUN:
                apply_raised_cap(promotion["id"], target_max_uses)

    log.info("Done. %d code(s) checked, %d code(s) flagged.", checked, flagged)


if __name__ == "__main__":
    run(apply_fix="--apply" in sys.argv)
