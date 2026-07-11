# Order webhooks stop firing entirely with no surfaced error

BigCommerce retries a failing webhook destination on a backoff schedule for roughly 48 hours, then permanently sets `is_active` to `false` on that subscription, emailing only the address on file for the subscribing app, never surfacing anything in the store control panel. Separately, once a destination domain has received 100 or more requests, BigCommerce tracks a rolling 2 minute success and failure ratio and blocklists the whole domain for 3 minutes if the success rate drops below 90 percent, which can fail deliveries even on a hook that still reads `is_active:true`. This job pulls recent orders, the store's current hook subscriptions, and the store's own webhook receiver log, and reports any hook that is deactivated or has gone stale with no recent delivery. It never auto-reactivates a hook; that is a separate, guarded, dry-run-respecting step you take only after confirming the receiving endpoint is healthy again.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-webhooks-stop-firing-silently/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="1"
export STALE_AFTER_MINUTES="30"
export DRY_RUN="true"

python order-webhooks-stop-firing-silently/python/detect_webhook_gap.py
node   order-webhooks-stop-firing-silently/node/detect-webhook-gap.js
```

`detect_webhook_gap` (`detectWebhookGap` in Node) is a pure function that takes order timestamps, your webhook receiver log grouped by scope, the raw `/v3/hooks` records, and the current time, and returns a list of findings. It is fully testable without a network call. A hook with `is_active:false` is reported as `"deactivated"`. A hook still `is_active:true` whose scope has no delivery recent enough relative to the newest matching order event is reported as `"stale_no_recent_delivery"`. Reactivation is never automatic: confirm the destination is healthy, then reactivate with a guarded `PUT /v3/hooks/{hook_id}` behind `DRY_RUN=true` by default.

## Test

```bash
pytest order-webhooks-stop-firing-silently/python
node --test order-webhooks-stop-firing-silently/node
```
