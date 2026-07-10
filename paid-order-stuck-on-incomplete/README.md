# Paid order stuck on Incomplete

BigCommerce writes an order at status_id 0 (Incomplete) the moment a shopper reaches the payment page, before the gateway result comes back. A second call is supposed to flip it to Awaiting Fulfillment (status_id 11). When that callback is delayed, dropped, or the gateway never notifies BigCommerce, the order is stuck on Incomplete even though a real transaction and a capture exist on the gateway side. Incomplete orders are excluded from the normal fulfillment queue, so these sit invisible until a customer complains.

This job lists Incomplete orders in a lookback window, pulls each order's transactions, and classifies it with a pure function. Confirmed paid-but-incomplete orders move to Awaiting Fulfillment. Orders with conflicting signals (a capture followed by a void, or a decline) are only logged for manual review, never auto-repaired.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/paid-order-stuck-on-incomplete/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python paid-order-stuck-on-incomplete/python/reconcile_incomplete_orders.py
node   paid-order-stuck-on-incomplete/node/reconcile-incomplete-orders.js
```

`decide_order_repair` (Python) and `decideOrderRepair` (Node) are pure functions that take an order's `status_id` and its list of transactions and return `"no_action"`, `"advance_to_awaiting_fulfillment"`, or `"flag_for_review"`. They never touch the network, so they are fully testable. Start with `DRY_RUN=true` to review the list before it writes anything.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest paid-order-stuck-on-incomplete/python
node --test paid-order-stuck-on-incomplete/node
```
