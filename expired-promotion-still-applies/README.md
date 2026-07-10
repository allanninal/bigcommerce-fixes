# Expired promotion still applies

BigCommerce's V3 Promotions object stores `status` (ENABLED/DISABLED) independently of `end_date`. The platform is expected to stop honoring a rule once `end_date` passes, but `status` itself is never automatically flipped to DISABLED in the API response, so any integration that only checks `status == "ENABLED"` keeps applying the discount. `end_date` is also evaluated in the store's configured Date and Timezone (Store Profile setting), effectively store-local 23:59:59 on the entered day, not UTC, so a naive UTC comparison can be off in either direction.

This job pages `GET /v3/promotions?status=ENABLED`, classifies each promotion with a pure function against `end_date` and `current_uses`/`max_uses`, cross-checks `GET /v2/orders` for orders placed after `end_date` to confirm the discount actually posted on a real order, re-fetches the single promotion right before writing to avoid racing a legitimate admin edit, and `PUT`s `{"status": "DISABLED"}` only when `DRY_RUN` is false.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/expired-promotion-still-applies/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python expired-promotion-still-applies/python/disable_expired_promotions.py
node   expired-promotion-still-applies/node/disable-expired-promotions.js
```

`classify_promotion` (Python) and `classifyPromotion` (Node) are pure functions that take one promotion and the current time and return `{expired, reason, action}`. A promotion that is not currently `ENABLED` is left alone. Otherwise it is flagged expired with reason `past_end_date` when `end_date` is non-null and at or before now (both parsed as UTC instants), or with reason `max_uses_reached` when `max_uses` is set and `current_uses` has reached it. `action` is `"DISABLE"` only when `expired` is true. They never touch the network, so they are fully testable. The script logs every candidate whether or not `DRY_RUN` suppresses the write, cross-checks real orders placed after `end_date` to confirm actual leakage, and re-fetches the promotion right before writing so it never races a legitimate admin edit. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest expired-promotion-still-applies/python
node --test expired-promotion-still-applies/node
```
