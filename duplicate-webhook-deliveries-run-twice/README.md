# Duplicate webhook deliveries run twice

BigCommerce's webhook dispatcher does not guarantee exactly-once delivery. A slow or non-2xx endpoint gets the identical payload retried for up to about 48 hours, up to 11 attempts, before the hook's `is_active` is set to false. Rapid back-to-back admin edits and duplicate active hook registrations on the same `scope` and `destination` can also make one logical event arrive more than once. This job computes a delivery id from `hash`, `created_at`, `scope`, and `producer` (the payload has no dedicated delivery id), classifies each delivery as a new event, a duplicate, or fan-out from a duplicate hook, and can find and deactivate the extra hooks. It never processes business logic twice and never touches the surviving hook's `is_active`.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/duplicate-webhook-deliveries-run-twice/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export WATCHED_SCOPES="store/order/updated"
export DRY_RUN="true"

python duplicate-webhook-deliveries-run-twice/python/dedupe_webhook_deliveries.py
node   duplicate-webhook-deliveries-run-twice/node/dedupe-webhook-deliveries.js
```

`classify_webhook_delivery` / `classifyWebhookDelivery` is a pure function with no I/O, so it is fully testable: same `hash` + `created_at` + `scope` + `producer` always hashes to the same delivery id and is classified `skip_duplicate` on a repeat, a different `created_at` a couple of seconds later is treated as a new event, and any scope with more than one active hook is classified `flag_fanout` regardless of whether the delivery id was seen before. The only write this script performs against BigCommerce is deactivating a confirmed duplicate hook with `PUT /v3/hooks/{id}`, and that write is guarded by `DRY_RUN`.

## Test

```bash
pytest duplicate-webhook-deliveries-run-twice/python
node --test duplicate-webhook-deliveries-run-twice/node
```
