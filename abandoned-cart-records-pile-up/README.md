# Abandoned cart records pile up

BigCommerce V3 cart records, created via the Storefront or Management Cart API,
never expire and never self-delete on the server. A cart persists indefinitely
until it either converts to an order or is explicitly deleted through the API.
Guest checkouts, abandoned-cart-recovery emails, headless storefront sessions,
and app integrations all create carts liberally, and BigCommerce's own
"abandoned" definition, one hour of inactivity, only triggers a recovery email,
never any cleanup. Stores accumulate large numbers of stale, empty, or orphaned
cart records over months or years with no built-in garbage collection.

This job pages `GET /v3/carts`, reads each cart's age and line item counts,
cross-checks `GET /v2/orders` to see whether the cart actually converted through
a different path, and classifies each cart with a pure function into
`empty_cart`, `converted_duplicate`, `abandoned_stale`, or `active`. Only
`empty_cart` and `converted_duplicate` are ever hard deleted with
`DELETE /v3/carts/{cartId}`, since both are verifiably safe. `abandoned_stale`
carts, which still have real items and no confirmed order, are only ever
flagged for a human to review, never auto-deleted.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/abandoned-cart-records-pile-up/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export STALE_DAYS="30"
export DRY_RUN="true"

python python/clean_stale_carts.py
node   node/clean-stale-carts.js
```

`classify_stale_cart` (Python) and `classifyStaleCart` (Node) are pure functions
that take a cart, whether a matching order exists, the current time, and a stale
day threshold, and return `{isStale, reason}`. They never touch the network, so
they are fully testable with fixed inputs. Start with `DRY_RUN=true` to review
what the script would delete or flag before anything writes.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest python
node --test node/*.test.js
```
