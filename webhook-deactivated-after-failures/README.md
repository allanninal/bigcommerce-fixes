# Webhook deactivated after failures

BigCommerce retries a failed webhook delivery, any response that is not HTTP 2xx, including timeouts and TLS errors, with exponential backoff for up to 11 attempts spanning roughly 48 hours. If the destination never returns a 2xx in that window, BigCommerce sets `is_active` to `false` on that hook and emails the address registered for the app, permanently pausing delivery until someone notices. A hook can also be auto deactivated after 90 days of zero triggered events. This job lists every hook with `GET /v3/hooks`, diffs it against a desired manifest of scope and destination pairs, health checks the destination before reactivating, and recreates anything missing entirely with `POST /v3/hooks`.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/webhook-deactivated-after-failures/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export DESIRED_WEBHOOKS_JSON='[{"scope":"store/order/created","destination":"https://app.example.com/hooks","is_active":true}]'
export DRY_RUN="true"

python webhook-deactivated-after-failures/python/reconcile_webhooks.py
node   webhook-deactivated-after-failures/node/reconcile-webhooks.js
```

`plan_webhook_reconciliation` is a pure function that only compares scope and destination keys between your desired manifest and the live `/v3/hooks` response, so it is fully testable with no network and no BigCommerce store. The script never flips `is_active` back to `true` without a fresh health check against the destination first, and it never assumes a missing hook can be undeleted, only recreated with a brand new id. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest webhook-deactivated-after-failures/python
node --test webhook-deactivated-after-failures/node
```
