"""Flag BigCommerce stores whose OAuth token silently died from a scope change.

BigCommerce invalidates a stored OAuth access token whenever the app's declared
scopes change in the app or Developer Portal profile. The token is only actually
replaced the next time the merchant reopens the app and re-consents through the
/auth callback, which returns a fresh access_token plus the new scope string. Any
script still holding the old token gets a generic 401 Unauthorized on every call
afterward, and there is no distinct "scope changed" error code, so scope drift and
plain revocation or expiry look identical unless the caller compares the scopes it
minted the token with against what the app currently requires.

This script calls a lightweight canary endpoint, classifies a 401 as SCOPE_DRIFT,
TRANSIENT_RETRY, or TOKEN_REVOKED_OR_EXPIRED with a pure function, and only ever
reports. It never tries to mint a replacement token itself, because BigCommerce
will not issue one without the merchant re-consenting. Safe to run again and
again, and safe by default with DRY_RUN.

Guide: https://www.allanninal.dev/bigcommerce/oauth-token-invalid-after-scope-change/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_oauth_scope_drift")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
CLIENT_ID = os.environ.get("BIGCOMMERCE_CLIENT_ID", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Accept": "application/json",
}


def scope_set(scope_string):
    return {s for s in (scope_string or "").split() if s}


def classify_auth_failure(
    status_code: int, stored_scopes: set, required_scopes: set, retry_count: int
) -> str:
    """Pure decision logic, no I/O.

    Returns one of: 'OK', 'SCOPE_DRIFT', 'TOKEN_REVOKED_OR_EXPIRED', 'TRANSIENT_RETRY'.
    - If status_code != 401: 'OK'.
    - If 401 and required_scopes - stored_scopes is non-empty: 'SCOPE_DRIFT' (force
      re-auth, no retry).
    - If 401, scopes match, and retry_count == 0: 'TRANSIENT_RETRY' (allow exactly
      one retry).
    - If 401, scopes match, and retry_count >= 1: 'TOKEN_REVOKED_OR_EXPIRED' (force
      re-auth, no further retry).
    """
    if status_code != 401:
        return "OK"

    if required_scopes - stored_scopes:
        return "SCOPE_DRIFT"

    if retry_count == 0:
        return "TRANSIENT_RETRY"

    return "TOKEN_REVOKED_OR_EXPIRED"


def canary_status_code():
    r = requests.get(
        f"{API_BASE}/catalog/products", headers=HEADERS, params={"limit": 1}, timeout=30
    )
    return r.status_code


def reauth_url(client_id, store_hash):
    return (
        "https://login.bigcommerce.com/oauth2/authorize"
        f"?client_id={client_id}&context=stores/{store_hash}"
    )


def run():
    stored_scopes = scope_set(os.environ.get("BIGCOMMERCE_STORED_SCOPES", ""))
    required_scopes = scope_set(os.environ.get("BIGCOMMERCE_REQUIRED_SCOPES", ""))

    retry_count = 0
    status_code = canary_status_code()
    outcome = classify_auth_failure(status_code, stored_scopes, required_scopes, retry_count)

    if outcome == "TRANSIENT_RETRY":
        retry_count = 1
        status_code = canary_status_code()
        outcome = classify_auth_failure(status_code, stored_scopes, required_scopes, retry_count)

    if outcome == "OK":
        log.info("store_hash=%s status=OK canary_status=%s", STORE_HASH, status_code)
        return

    missing_scopes = sorted(required_scopes - stored_scopes)
    log.warning(
        "store_hash=%s classification=%s last_known_scope=%s required_scope=%s "
        "missing_scopes=%s canary_status=%s retry_count=%s",
        STORE_HASH, outcome, sorted(stored_scopes), sorted(required_scopes),
        missing_scopes, status_code, retry_count,
    )

    if not DRY_RUN:
        log.warning(
            "store_hash=%s re_auth_url=%s",
            STORE_HASH, reauth_url(CLIENT_ID, STORE_HASH),
        )

    log.info(
        "Done. store_hash=%s stopping retries until a new access_token/scope pair is recorded.",
        STORE_HASH,
    )


if __name__ == "__main__":
    run()
