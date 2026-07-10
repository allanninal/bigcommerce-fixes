# Missed webhooks with no backfill

BigCommerce webhook delivery is at-least-once, but not durable on the receiver's behalf. If your endpoint is down or returns non-2xx, BigCommerce retries on a backoff schedule for roughly 48 hours across up to 11 attempts, then permanently gives up, flips the hook's `is_active` to false, and emails the app's registered contact. There is no dead letter queue, event log, or replay missed events API. This job confirms the gap, scans `GET /v2/orders` across the outage window, diffs each order against locally stored state with a pure decision function, and replays anything missing or stale through the app's own idempotent order sync handler. It never calls a destructive BigCommerce write; the only write is reactivating the hook once the backfill is confirmed.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/missed-webhooks-with-no-backfill/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export WINDOW_START="2026-07-05T00:00:00+00:00"
export WINDOW_END="2026-07-07T00:00:00+00:00"
export DRY_RUN="true"

python missed-webhooks-with-no-backfill/python/backfill_missed_webhooks.py
node   missed-webhooks-with-no-backfill/node/backfill-missed-webhooks.js
```

`is_order_missed` is a pure function that takes already-fetched local and remote order state plus the outage window and returns a bool, so the decision is fully testable without a network call or a BigCommerce store. Start with `DRY_RUN=true` to review the list of orders it would replay before it touches your own sync handler or reactivates the hook.

## Test

```bash
pytest missed-webhooks-with-no-backfill/python
node --test missed-webhooks-with-no-backfill/node
```
