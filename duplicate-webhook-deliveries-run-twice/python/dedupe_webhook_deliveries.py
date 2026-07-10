"""Classify BigCommerce webhook deliveries so a handler never processes a resend twice.

BigCommerce's dispatcher does not guarantee exactly-once delivery: a slow or non-2xx
endpoint gets the identical payload retried for up to about 48 hours, up to 11 attempts,
before the hook's is_active is set to false. Duplicate active hook registrations for the
same scope and destination also fan out one logical event into several deliveries. This
computes a delivery id from hash, created_at, scope, and producer (the payload has no
dedicated delivery id), skips anything already seen, and flags scopes where more than one
active hook would explain the duplicates. Also finds and, when confirmed, deactivates the
extra hooks. Run on a schedule for the hook scan. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/duplicate-webhook-deliveries-run-twice/
"""
import os
import hashlib
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dedupe_webhook_deliveries")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
WATCHED_SCOPES = [s.strip() for s in os.environ.get("WATCHED_SCOPES", "store/order/updated").split(",") if s.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def classify_webhook_delivery(payload, seen_delivery_ids, active_hooks_for_scope):
    """Pure decision function. No network calls.

    payload: {"scope": str, "hash": str, "created_at": int, "producer": str}
    seen_delivery_ids: a set-like of delivery ids already processed
    active_hooks_for_scope: count of active hooks sharing this scope + destination
    """
    raw = f"{payload['hash']}|{payload['created_at']}|{payload['scope']}|{payload['producer']}"
    delivery_id = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    if active_hooks_for_scope > 1:
        return {"deliveryId": delivery_id, "action": "flag_fanout"}
    if delivery_id in seen_delivery_ids:
        return {"deliveryId": delivery_id, "action": "skip_duplicate"}
    return {"deliveryId": delivery_id, "action": "process"}


def handle_delivery(payload, seen_delivery_ids, active_hooks_for_scope, process_fn):
    """Returns True if the payload was processed, False if it was skipped or flagged."""
    result = classify_webhook_delivery(payload, seen_delivery_ids, active_hooks_for_scope)
    if result["action"] != "process":
        log.info("Delivery %s %s, not reprocessing.", result["deliveryId"][:12], result["action"])
        return False
    seen_delivery_ids.add(result["deliveryId"])
    process_fn(payload)
    return True


def active_hooks_for_scope(scope):
    resp = bc("GET", f"/v3/hooks?scope={scope}&limit=250")
    return [h for h in (resp or {}).get("data", []) if h.get("is_active")]


def duplicate_fanout_groups(scope):
    """Group active hooks for a scope by destination, keep groups with more than one."""
    by_destination = {}
    for hook in active_hooks_for_scope(scope):
        by_destination.setdefault(hook["destination"], []).append(hook)
    return {dest: hooks for dest, hooks in by_destination.items() if len(hooks) > 1}


def deactivate_hook(hook_id):
    return bc("PUT", f"/v3/hooks/{hook_id}", json={"is_active": False})


def run():
    flagged = 0
    for scope in WATCHED_SCOPES:
        groups = duplicate_fanout_groups(scope)
        for destination, hooks in groups.items():
            hooks_sorted = sorted(hooks, key=lambda h: h.get("created_at", 0))
            keep, extras = hooks_sorted[0], hooks_sorted[1:]
            log.warning(
                "Scope %s destination %s has %d active hooks. Keeping id=%s, %s: %s",
                scope, destination, len(hooks_sorted), keep["id"],
                "would deactivate" if DRY_RUN else "deactivating",
                [h["id"] for h in extras],
            )
            if not DRY_RUN:
                for hook in extras:
                    deactivate_hook(hook["id"])
            flagged += len(extras)
    log.info("Done. %d duplicate hook(s) %s.", flagged, "to deactivate" if DRY_RUN else "deactivated")


if __name__ == "__main__":
    run()
