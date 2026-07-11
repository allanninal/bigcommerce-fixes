"""Edit BigCommerce coupon max_uses without wiping applies_to.

The legacy V2 Coupons endpoint (PUT /stores/{store_hash}/v2/coupons/{id})
treats PUT as a full-object replace, not a true partial patch, for the
applies_to sub-object. BigCommerce's own docs state that if applies_to is
not included in the PUT request, its existing value on the coupon will be
cleared. A script that PUTs only {"max_uses": 50} to bump a usage cap
silently resets applies_to back to its default (entity "products" or
"categories" with an empty ids state), wiping the coupon's product or
category restriction. The response is still 200 and every other field
looks correct, so the loss is silent and usually only noticed once the
coupon starts applying store-wide.

This script snapshots every coupon before any write, re-fetches the
freshest copy right before each PUT, always composes the PUT body by
merging the snapshot into desired_changes (never a bare partial), and
verifies with a follow-up GET that applies_to survived. If a wipe is
detected, a corrective PUT resending the snapshotted applies_to is logged
(DRY_RUN=true) or sent and re-verified (DRY_RUN=false). Coupons with no
prior snapshot are flagged for manual review, never guessed.

Guide: https://www.allanninal.dev/bigcommerce/coupon-applies-to-wiped-on-max-uses-edit/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_coupon_applies_to")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

WIPE_RISK_FIELDS = ("applies_to",)

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def plan_coupon_update(snapshot: dict, desired_changes: dict) -> dict:
    """Pure decision. No network, no side effects.

    Merges desired_changes on top of a full copy of snapshot, so the
    returned body always re-asserts every untouched field (especially
    applies_to) instead of omitting it. Also returns wipeRiskFields, the
    list of fields present in snapshot but absent from desired_changes
    that are known to be cleared on omission by this endpoint, purely
    for logging and assertions.
    """
    if "id" not in snapshot:
        raise ValueError("snapshot must include an id")

    body = dict(snapshot)
    body.update(desired_changes)
    body.pop("id", None)

    wipe_risk_fields = [
        field for field in WIPE_RISK_FIELDS
        if field in snapshot and field not in desired_changes
    ]

    return {
        "method": "PUT",
        "path": f"/coupons/{snapshot['id']}",
        "body": body,
        "wipeRiskFields": wipe_risk_fields,
    }


def all_coupons():
    """Page through every coupon in the store."""
    page = 1
    while True:
        coupons = bc_get("/coupons", {"limit": 250, "page": page})
        if not coupons:
            return
        for coupon in coupons:
            yield coupon
        page += 1


def snapshot_coupons():
    return {str(c["id"]): c for c in all_coupons()}


def apply_coupon_update(coupon_id, desired_changes, snapshot_store):
    """Re-fetch fresh, merge with the snapshot, PUT, then verify.

    Returns (after, wiped). If no prior snapshot exists for coupon_id,
    logs a manual-review flag and returns (None, None) without writing.
    """
    key = str(coupon_id)
    if key not in snapshot_store:
        log.warning(
            "coupon_id=%s has no prior snapshot. Flagging for manual review, "
            "not guessing applies_to.",
            coupon_id,
        )
        return None, None

    fresh = bc_get(f"/coupons/{coupon_id}")
    plan = plan_coupon_update(fresh, desired_changes)

    log.info(
        "coupon_id=%s desired_changes=%s wipe_risk_fields=%s (%s)",
        coupon_id, desired_changes, plan["wipeRiskFields"],
        "dry run" if DRY_RUN else "writing",
    )

    if DRY_RUN:
        return fresh, False

    bc_put(plan["path"], plan["body"])

    after = bc_get(f"/coupons/{coupon_id}")
    expected_applies_to = plan["body"].get("applies_to")
    wiped = expected_applies_to is not None and after.get("applies_to") != expected_applies_to

    if wiped:
        corrective_body = dict(after)
        corrective_body["applies_to"] = snapshot_store[key]["applies_to"]
        corrective_body.pop("id", None)
        log.warning(
            "coupon_id=%s wipe detected after write. Corrective applies_to=%s (%s)",
            coupon_id, snapshot_store[key]["applies_to"],
            "dry run, not sent" if DRY_RUN else "sending corrective PUT",
        )
        if not DRY_RUN:
            bc_put(f"/coupons/{coupon_id}", corrective_body)
            after = bc_get(f"/coupons/{coupon_id}")

    return after, wiped


def run():
    snapshot_store = snapshot_coupons()
    log.info("Snapshotted %d coupon(s).", len(snapshot_store))

    wiped_count = 0
    flagged_count = 0

    for coupon_id, coupon in snapshot_store.items():
        desired_changes = {}
        if not desired_changes:
            continue

        after, wiped = apply_coupon_update(coupon_id, desired_changes, snapshot_store)
        if after is None:
            flagged_count += 1
        elif wiped:
            wiped_count += 1

    log.info(
        "Done. %d coupon(s) had a wipe detected and corrected, %d flagged for manual review.",
        wiped_count, flagged_count,
    )


if __name__ == "__main__":
    run()
