"""Detect and repair a BigCommerce app's missing store/app/uninstalled webhook.

BigCommerce's /v3/hooks endpoint validates the scope field against a fixed
allow list of exact scope strings, with no fuzzy matching or aliasing. The
correct, documented scope for uninstall notification is the past tense
store/app/uninstalled, but it is common to submit the present tense
store/app/uninstall, or another near miss copied from an older doc, a blog
post, or memory. Because the string does not match anything on the allow
list, BigCommerce rejects the create webhook request with a 400 rather than
registering a broken hook, so the app is never subscribed and silently never
learns when a merchant uninstalls it. This job lists every hook a store has
registered, classifies whether the expected scope is present and active, and
only when explicitly allowed re-registers the correct scope. It never deletes
or mutates an existing near miss hook. Run once after any app config change
and periodically as a safety net. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/uninstall-webhook-registration-rejected/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_uninstall_webhook")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
UNINSTALL_WEBHOOK_URL = os.environ.get("UNINSTALL_WEBHOOK_URL", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EXPECTED_SCOPE = "store/app/uninstalled"
NEAR_MISS_SCOPES = {"store/app/uninstall", "app/uninstalled", "store/app/Uninstalled"}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def find_uninstall_scope_gap(registered_hooks: list, expected_scope: str = EXPECTED_SCOPE) -> dict:
    """Pure decision. No network, no side effects.

    registered_hooks: list of hook dicts from GET /v3/hooks `data` array, each with
        keys like {"id": int, "scope": str, "destination": str, "is_active": bool}.
    Returns a decision record:
        {"status": "ok"}
        {"status": "missing"}
        {"status": "inactive", "hook_id": 123}
        {"status": "near_miss", "hook_id": 123, "found_scope": "store/app/uninstall"}

    Scans the list once. An active hook with the exact expected scope wins
    immediately, even if a near-miss hook was seen earlier in the list. If the
    expected scope exists but is not active, that is reported before falling
    back to any near-miss. If nothing matches the expected scope at all, the
    first near-miss scope found (if any) is reported, otherwise the store is
    missing the hook entirely.
    """
    near_miss_hook = None

    for hook in registered_hooks or []:
        scope = hook.get("scope")
        if scope == expected_scope:
            if hook.get("is_active"):
                return {"status": "ok"}
            return {"status": "inactive", "hook_id": hook.get("id")}
        if scope in NEAR_MISS_SCOPES and near_miss_hook is None:
            near_miss_hook = hook

    if near_miss_hook is not None:
        return {
            "status": "near_miss",
            "hook_id": near_miss_hook.get("id"),
            "found_scope": near_miss_hook.get("scope"),
        }

    return {"status": "missing"}


def list_hooks():
    """Page through every hook currently registered for the store."""
    hooks = []
    page = 1
    while True:
        payload = bc_get("/hooks", {"page": page, "limit": 50})
        page_hooks = payload.get("data", [])
        if not page_hooks:
            return hooks
        hooks.extend(page_hooks)
        pagination = payload.get("meta", {}).get("pagination", {})
        if page >= pagination.get("total_pages", page):
            return hooks
        page += 1


def register_uninstall_hook(destination):
    body = {"scope": EXPECTED_SCOPE, "destination": destination, "is_active": True}
    response = bc_post("/hooks", body)
    data = response.get("data", {})
    if data.get("scope") != EXPECTED_SCOPE:
        raise RuntimeError(f"Unexpected response registering uninstall hook: {response}")
    return data


def run():
    hooks = list_hooks()
    decision = find_uninstall_scope_gap(hooks)
    status = decision["status"]

    if status == "ok":
        log.info("store_hash=%s status=ok. Active store/app/uninstalled hook already registered.", STORE_HASH)
        return

    if status == "near_miss":
        log.warning(
            "store_hash=%s status=near_miss hook_id=%s found_scope=%s expected_scope=%s. "
            "Existing hook left untouched.",
            STORE_HASH, decision.get("hook_id"), decision.get("found_scope"), EXPECTED_SCOPE,
        )
    elif status == "inactive":
        log.warning(
            "store_hash=%s status=inactive hook_id=%s expected_scope=%s.",
            STORE_HASH, decision.get("hook_id"), EXPECTED_SCOPE,
        )
    else:
        log.warning("store_hash=%s status=missing expected_scope=%s.", STORE_HASH, EXPECTED_SCOPE)

    if DRY_RUN:
        log.info(
            "store_hash=%s dry run: would register scope=%s destination=%s",
            STORE_HASH, EXPECTED_SCOPE, UNINSTALL_WEBHOOK_URL,
        )
        return

    if not UNINSTALL_WEBHOOK_URL:
        raise RuntimeError("UNINSTALL_WEBHOOK_URL must be set to register the uninstall hook.")

    created = register_uninstall_hook(UNINSTALL_WEBHOOK_URL)
    log.info("store_hash=%s registered scope=%s hook_id=%s", STORE_HASH, EXPECTED_SCOPE, created.get("id"))


if __name__ == "__main__":
    run()
