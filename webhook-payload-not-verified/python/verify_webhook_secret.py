"""Classify BigCommerce webhook requests so a handler never trusts an unverified payload.

BigCommerce webhook callbacks carry a hash field, but BigCommerce has never published
a supported formula for validating it, so its presence is not real verification. The
documented safeguard is the optional headers object you set when creating a hook with
POST /v3/hooks, which BigCommerce echoes back on every callback as a shared secret.
This scans hooks for a missing secret, provisions one when confirmed missing, and
exposes a pure classification function a receiver can use before ever acting on the
payload. Run the scan on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/webhook-payload-not-verified/
"""
import os
import hmac
import secrets
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("verify_webhook_secret")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
HEADER_NAME = os.environ.get("WEBHOOK_SECRET_HEADER_NAME", "X-Webhook-Secret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def classify_webhook_request(hook, incoming):
    """Pure decision function. No network calls.

    hook: {"headers": {name: value, ...}} or {} / missing if none configured
    incoming: {"headers": {...}, "secretKeyName": str, "mutationRanBeforeCheck": bool}

    Returns one of:
      "UNVERIFIABLE_NO_SECRET"    - nothing was ever provisioned to check against
      "REJECT_MISMATCH"           - the secret header did not match
      "REJECT_USED_BEFORE_CHECK"  - matched, but a mutation ran before the check
      "TRUSTED"                  - matched, and checked before any mutation
    """
    hook_headers = hook.get("headers") or {}
    if not hook_headers:
        return "UNVERIFIABLE_NO_SECRET"

    key = incoming["secretKeyName"]
    expected = hook_headers.get(key)
    actual = (incoming.get("headers") or {}).get(key)
    if expected is None or actual is None or not hmac.compare_digest(expected, actual):
        return "REJECT_MISMATCH"

    if incoming.get("mutationRanBeforeCheck"):
        return "REJECT_USED_BEFORE_CHECK"

    return "TRUSTED"


def all_hooks():
    resp = bc("GET", "/v3/hooks?limit=250")
    return (resp or {}).get("data", [])


def hooks_missing_secret():
    """Hooks with no headers object at all, meaning nothing was ever provisioned to check."""
    return [h for h in all_hooks() if not h.get("headers")]


def provision_secret(hook_id, header_name):
    value = secrets.token_hex(32)
    return bc("PUT", f"/v3/hooks/{hook_id}", json={
        "headers": {header_name: value},
        "is_active": True,
    })


def run():
    fixed = 0
    for hook in hooks_missing_secret():
        log.warning(
            "Hook %s scope=%s destination=%s has no secret header. %s",
            hook.get("id"), hook.get("scope"), hook.get("destination"),
            "would provision" if DRY_RUN else "provisioning",
        )
        if not DRY_RUN:
            provision_secret(hook["id"], HEADER_NAME)
        fixed += 1
    log.info("Done. %d hook(s) %s.", fixed, "to provision" if DRY_RUN else "provisioned")


if __name__ == "__main__":
    run()
