# Webhook fires duplicate events within the same second

BigCommerce's webhook service guarantees at-least-once delivery, not exactly-once. If your endpoint is slow, times out, or its 200 OK response is lost in transit, the retry mechanism re-sends the same logical event. Separately, a single admin or API action can legitimately trigger more than one webhook subscription within the same second, and each carries its own `created_at` and a `hash` that is not guaranteed stable, so hash alone cannot be trusted to detect true duplicates. This script keeps a short-lived idempotency store keyed on `(resource_id, new_status_id)` with `created_at` rounded into a window, drops repeats inside that window, confirms the order's real state with `GET /v2/orders/{id}` when needed, and separately checks `GET /v3/hooks` for a duplicate hook registration on the same scope and destination, a common misconfiguration that doubles every delivery. It never writes to order state.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/webhook-duplicate-events-same-second/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DEDUPE_WINDOW_SECONDS="2"
export DRY_RUN="true"

python webhook-duplicate-events-same-second/python/dedupe_same_second_webhooks.py
node   webhook-duplicate-events-same-second/node/dedupe-same-second-webhooks.js
```

`is_duplicate_webhook_event` (`isDuplicateWebhookEvent` in Node) is a pure function that takes only a dict/Map of previously seen `(resource_id, new_status_id)` keys, the new event's identifying fields, and a window in seconds, so it is fully testable without a network call. It returns `True` (duplicate, drop it) only when a prior entry for the same key exists within the window, and always treats a different `new_status_id` for the same `resource_id` as a distinct event. The only write this script performs against BigCommerce is deleting a confirmed redundant webhook registration with `DELETE /v3/hooks/{id}`, and that write is guarded by `DRY_RUN`. It never modifies an order's status_id, since BigCommerce already applied that correctly; the bug being fixed is redundant notification delivery, not redundant order mutation.

## Test

```bash
pytest webhook-duplicate-events-same-second/python
node --test webhook-duplicate-events-same-second/node
```
