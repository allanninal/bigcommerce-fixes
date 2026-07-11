# OAuth token silently stops working after app scopes change

BigCommerce invalidates a stored OAuth access token whenever the app's declared scopes change in the app or Developer Portal profile. The token is only actually replaced the next time the merchant reopens the app and re-consents through the `/auth` callback, which returns a fresh `access_token` plus the new `scope` string. Any script still holding the old token gets a generic 401 Unauthorized on every call afterward, with no distinct "scope changed" error code, so scope drift and plain revocation or expiry look identical unless the caller compares the scopes it minted the token with against what the app currently requires. This job calls a lightweight canary endpoint, classifies the result with a pure function, and only ever flags the store and reports a re-auth link. It never tries to mint a replacement token itself.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/oauth-token-invalid-after-scope-change/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export BIGCOMMERCE_STORED_SCOPES="store_v2_orders store_v2_products"
export BIGCOMMERCE_REQUIRED_SCOPES="store_v2_orders store_v2_products store_v2_customers"
export BIGCOMMERCE_CLIENT_ID="your_app_client_id"
export DRY_RUN="true"

python oauth-token-invalid-after-scope-change/python/check_oauth_scope_drift.py
node   oauth-token-invalid-after-scope-change/node/check-oauth-scope-drift.js
```

`classify_auth_failure` (`classifyAuthFailure` in Node) is a pure function that takes only a status code, a set of stored scopes, a set of required scopes, and a retry count, so it is fully testable without a network call. It returns `SCOPE_DRIFT` when the stored token is missing a scope the app now requires, `TRANSIENT_RETRY` on the first 401 with matching scopes, `TOKEN_REVOKED_OR_EXPIRED` on a second consecutive 401 with matching scopes, and `OK` otherwise. Start with `DRY_RUN=true` to review the flagged stores before the script emits any re-auth URL.

## Test

```bash
pytest oauth-token-invalid-after-scope-change/python
node --test oauth-token-invalid-after-scope-change/node
```
