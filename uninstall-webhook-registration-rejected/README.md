# Uninstall webhook registration silently rejected

BigCommerce's /v3/hooks endpoint validates the scope field against a fixed allow list of exact scope strings, with no fuzzy matching or aliasing. The correct, documented scope for uninstall notification is the past tense store/app/uninstalled, but developers frequently submit the present tense store/app/uninstall, or another near-miss variant copied from older docs, blog posts, or memory. Because the string does not match any known scope, BigCommerce rejects the create-webhook request outright with a 400 (invalid scope) rather than registering a broken hook, so the app is never subscribed and silently never learns when a merchant uninstalls it. This job lists every hook a store has registered, classifies whether an active store/app/uninstalled hook exists, and only when explicitly allowed re-registers the correct scope. It never deletes or mutates an existing near-miss hook.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/uninstall-webhook-registration-rejected/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export UNINSTALL_WEBHOOK_URL="https://myapp.example.com/webhooks/uninstalled"
export DRY_RUN="true"

python uninstall-webhook-registration-rejected/python/repair_uninstall_webhook.py
node   uninstall-webhook-registration-rejected/node/repair-uninstall-webhook.js
```

`find_uninstall_scope_gap` (`findUninstallScopeGap` in Node) is a pure function that takes only a list of registered hook dicts and returns a classification: `ok`, `missing`, `inactive`, or `near_miss` (with the offending scope string). It is fully testable without a network call. Start with `DRY_RUN=true` to review the classification first; only when `DRY_RUN=false` does the script call `POST /v3/hooks` to register the correctly spelled `store/app/uninstalled` scope. Any existing near-miss hook is left in place and only logged, since its destination may be a customer-configured value.

## Test

```bash
pytest uninstall-webhook-registration-rejected/python
node --test uninstall-webhook-registration-rejected/node
```
