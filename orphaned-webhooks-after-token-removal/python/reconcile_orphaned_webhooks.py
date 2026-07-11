"""Find and safely clear BigCommerce webhooks orphaned by app or token removal.

Uninstalling an app through the App Marketplace flow, or deleting an API account
through the control panel, cascades to delete that client_id's webhooks. Every
other way an app or token disappears, an ad-hoc token revocation, a legacy
store-level credential, or an app that never received the store/app/uninstall
event, leaves its webhooks fully intact and still firing. GET /v3/hooks only
returns hooks tied to the client_id of the credential making the call, so no
single request shows every webhook a store has ever registered. This job lists
hooks visible to the configured credential, diffs each hook's client_id against
a known-good set of currently installed apps, and only deletes a hook when it is
both unowned and already deactivated by BigCommerce for a long stretch. A still
active, unrecognized hook is flagged for a human, never deleted automatically.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/orphaned-webhooks-after-token-removal/
"""
import os
import time
import logging
from typing import Literal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_orphaned_webhooks")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
KNOWN_CLIENT_IDS = {
    c.strip() for c in os.environ.get("KNOWN_CLIENT_IDS", "").split(",") if c.strip()
}
STALE_AFTER_DAYS = int(os.environ.get("STALE_AFTER_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_delete(path):
    r = requests.delete(f"{API_BASE}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def classify_hook(
    hook: dict, known_client_ids: set, now_epoch: int, stale_after_days: int = 90
) -> Literal["keep", "orphan_delete", "orphan_flag_only", "stale_inactive"]:
    """Pure decision. No network, no side effects.

    hook: {id, client_id, scope, destination, is_active, created_at, updated_at}
    known_client_ids: set of client_id strings for currently installed/authorized
      apps (or the single store-level client_id set the operator trusts).

    1. If hook['client_id'] in known_client_ids -> 'keep'.
    2. Else (client_id not recognized):
         a. If hook['is_active'] is False and (now_epoch - hook['updated_at'])
              > stale_after_days*86400 -> 'orphan_delete' (safe: already
              deactivated by BigCommerce AND unowned).
         b. Elif hook['is_active'] is True -> 'orphan_flag_only' (still firing
              for an unrecognized owner; needs human confirm before delete).
         c. Else -> 'stale_inactive' (recently deactivated, unrecognized owner,
              but not old enough to auto-clear).
    """
    if hook.get("client_id") in known_client_ids:
        return "keep"

    is_active = bool(hook.get("is_active"))
    updated_at = hook.get("updated_at") or 0
    age_seconds = now_epoch - updated_at
    is_stale = age_seconds > stale_after_days * 86400

    if not is_active and is_stale:
        return "orphan_delete"
    if is_active:
        return "orphan_flag_only"
    return "stale_inactive"


def list_hooks():
    """Page through every hook visible to the configured credential."""
    page = 1
    while True:
        payload = bc_get("/hooks", {"page": page, "limit": 50})
        items = payload.get("data") or []
        if not items:
            return
        for hook in items:
            yield hook
        next_link = (payload.get("meta") or {}).get("pagination", {}).get("links", {}).get("next")
        if not next_link:
            return
        page += 1


def delete_hook(hook_id):
    return bc_delete(f"/hooks/{hook_id}")


def run():
    deleted = 0
    flagged = 0
    stale = 0
    now_epoch = int(time.time())

    for hook in list_hooks():
        decision = classify_hook(hook, KNOWN_CLIENT_IDS, now_epoch, STALE_AFTER_DAYS)

        if decision == "keep":
            continue

        if decision == "stale_inactive":
            log.info(
                "Hook %s (client_id=%s) is recently inactive but not old enough to clear yet.",
                hook.get("id"), hook.get("client_id"),
            )
            stale += 1
            continue

        if decision == "orphan_flag_only":
            log.warning(
                "Hook %s flagged for review. client_id=%s scope=%s destination=%s "
                "is_active=%s created_at=%s",
                hook.get("id"), hook.get("client_id"), hook.get("scope"),
                hook.get("destination"), hook.get("is_active"), hook.get("created_at"),
            )
            flagged += 1
            continue

        log.info(
            "id=%s client_id=%s scope=%s destination=%s is_active=%s created_at=%s (%s)",
            hook.get("id"), hook.get("client_id"), hook.get("scope"),
            hook.get("destination"), hook.get("is_active"), hook.get("created_at"),
            "dry run" if DRY_RUN else "deleting",
        )
        if not DRY_RUN:
            delete_hook(hook.get("id"))
        deleted += 1

    log.info(
        "Done. %d hook(s) %s, %d hook(s) flagged for review, %d hook(s) stale but not yet clearable.",
        deleted, "to delete" if DRY_RUN else "deleted", flagged, stale,
    )


if __name__ == "__main__":
    run()
