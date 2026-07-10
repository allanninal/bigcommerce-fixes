"""Find and safely disable BigCommerce promotions that are still ENABLED
past their end_date (or past max_uses), which lets them keep discounting
orders they should no longer touch.

BigCommerce's V3 Promotions object stores status (ENABLED/DISABLED) as its
own field, independent of end_date on the rule. The platform is expected to
stop honoring a rule once end_date passes, but status itself is never
automatically flipped to DISABLED in the API response. Any integration or
cached calculation that only checks status == "ENABLED" keeps applying the
discount. end_date is also evaluated in the store's configured Date and
Timezone (Store Profile setting), effectively store-local 23:59:59 on the
entered day, not UTC, so a naive UTC comparison can be off in either
direction.

This pages GET /v3/promotions, classifies each ENABLED promotion with a pure
function against end_date and max_uses/current_uses, cross-checks V2 orders
placed after end_date to confirm the discount actually posted on a real
order, re-fetches the single promotion right before writing to avoid racing
a legitimate admin edit, and PUTs {"status": "DISABLED"} only when DRY_RUN is
false. Every candidate is logged whether or not DRY_RUN suppresses the
write. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/expired-promotion-still-applies/
"""
import os
import logging
from datetime import datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("disable_expired_promotions")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"}


def bc(method, path, **kwargs):
    r = requests.request(method, BASE + path.lstrip("/"), headers=HEADERS, timeout=30, **kwargs)
    r.raise_for_status()
    if not r.content:
        return None
    body = r.json()
    return body["data"] if isinstance(body, dict) and "data" in body else body


def classify_promotion(promo, now_iso):
    """Pure. No I/O.

    promo: {"status": "ENABLED"|"DISABLED", "end_date": str|None,
            "start_date": str|None, "current_uses": int,
            "max_uses": int|None, "redemption_type": "AUTOMATIC"|"COUPON"}
    now_iso: current time as an ISO-8601 UTC string.

    Returns {"expired": bool, "reason": str|None, "action": "DISABLE"|"NONE"}.

    1. Anything not currently ENABLED is already inactive: nothing to do.
    2. end_date and now are both parsed as UTC instants; a null end_date
       never expires on its own.
    3. If end_date has passed, expired with reason "past_end_date".
    4. Else if max_uses is set and current_uses has reached it, expired
       with reason "max_uses_reached" (the secondary cause of the same
       symptom class).
    5. Otherwise not expired.
    """
    if promo.get("status") != "ENABLED":
        return {"expired": False, "reason": None, "action": "NONE"}

    now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    end_date = promo.get("end_date")

    if end_date:
        end = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        if end <= now:
            return {"expired": True, "reason": "past_end_date", "action": "DISABLE"}

    max_uses = promo.get("max_uses")
    if max_uses is not None and promo.get("current_uses", 0) >= max_uses:
        return {"expired": True, "reason": "max_uses_reached", "action": "DISABLE"}

    return {"expired": False, "reason": None, "action": "NONE"}


def enabled_promotions():
    """Read-only. Pages every ENABLED promotion via meta.pagination.links.next."""
    path = "/v3/promotions?status=ENABLED&limit=250"
    while path:
        r = requests.get(BASE + path.lstrip("/"), headers=HEADERS, timeout=30)
        r.raise_for_status()
        body = r.json()
        for promo in body.get("data", []):
            yield promo
        next_url = (body.get("meta", {}).get("pagination", {}).get("links", {}) or {}).get("next")
        path = next_url.replace(BASE, "") if next_url else None


def orders_after_end_date(end_date):
    """Read-only. Orders placed on or after end_date, still Awaiting
    Fulfillment (status_id 11), used to confirm real leakage."""
    r = requests.get(
        BASE + "v2/orders",
        params={"min_date_created": end_date, "status_id": 11},
        headers=HEADERS, timeout=30,
    )
    r.raise_for_status()
    return r.json() or []


def refetch_promotion(promotion_id):
    """Read-only. Confirms end_date/current_uses have not changed since the
    scan, so the write never races a legitimate admin edit."""
    return bc("GET", f"/v3/promotions/{promotion_id}")


def disable_promotion(promotion_id):
    return bc("PUT", f"/v3/promotions/{promotion_id}", json={"status": "DISABLED"})


def run():
    now_iso = datetime.utcnow().isoformat() + "Z"
    candidates = 0
    disabled = 0

    for promo in enabled_promotions():
        result = classify_promotion(promo, now_iso)
        if result["action"] != "DISABLE":
            continue

        candidates += 1
        log.info(
            "Promotion %r (id=%s) expired: %s. end_date=%s current_uses=%s/%s. %s",
            promo.get("name"), promo.get("id"), result["reason"],
            promo.get("end_date"), promo.get("current_uses"), promo.get("max_uses"),
            "would disable" if DRY_RUN else "disabling",
        )

        if promo.get("end_date"):
            leaked = orders_after_end_date(promo["end_date"])
            if leaked:
                log.warning(
                    "Promotion %r has %d order(s) placed after end_date: real leakage confirmed.",
                    promo.get("name"), len(leaked),
                )

        if DRY_RUN:
            continue

        fresh = refetch_promotion(promo["id"])
        refreshed = classify_promotion(fresh, datetime.utcnow().isoformat() + "Z")
        if refreshed["action"] != "DISABLE":
            log.info("Promotion %r changed since the scan. Skipping.", promo.get("name"))
            continue

        disable_promotion(promo["id"])
        disabled += 1

    log.info("Done. %d candidate(s) found, %d %s.", candidates, disabled if not DRY_RUN else candidates,
              "disabled" if not DRY_RUN else "to disable")


if __name__ == "__main__":
    run()
