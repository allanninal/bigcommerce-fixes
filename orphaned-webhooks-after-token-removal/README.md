# Webhook keeps firing after its owning app or token is removed

BigCommerce only cascades a clean delete of a client_id's webhooks when an app is uninstalled through the App Marketplace flow, or when its API account is deleted in the control panel. Every other way an app or token disappears, an ad-hoc token revocation, a legacy store-level credential, or an app that never received the `store/app/uninstall` event, leaves its webhooks fully intact and firing. Worse, `GET /v3/hooks` only returns hooks tied to the client_id of the credential making the call, so no single request shows every webhook a store has ever registered. This job lists hooks visible to the configured credential, diffs each hook's client_id against a known-good set of currently installed apps, and only deletes a hook when it is both unowned and already deactivated by BigCommerce for a long stretch. A still-active, unrecognized hook is flagged for a human, never deleted automatically.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/orphaned-webhooks-after-token-removal/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export KNOWN_CLIENT_IDS="client_abc,client_def"
export STALE_AFTER_DAYS="90"
export DRY_RUN="true"

python orphaned-webhooks-after-token-removal/python/reconcile_orphaned_webhooks.py
node   orphaned-webhooks-after-token-removal/node/reconcile-orphaned-webhooks.js
```

`classify_hook` (`classifyHook` in Node) is a pure function that takes only a hook, the set of known client_ids, the current epoch time, and a staleness window, so it is fully testable without a network call. It only returns `orphan_delete` when a hook's client_id is unrecognized and BigCommerce has already marked it inactive for longer than `stale_after_days`. A still-active unrecognized hook returns `orphan_flag_only` instead, so it is never deleted automatically. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest orphaned-webhooks-after-token-removal/python
node --test orphaned-webhooks-after-token-removal/node
```
