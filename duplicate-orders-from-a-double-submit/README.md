# Duplicate orders from a double submit

BigCommerce's hosted checkout does not natively debounce the final Place Order submit button. A slow payment gateway response or an impatient double click creates two separate cart-to-order conversions before the first request returns, producing two distinct order records with identical line items, totals, and customer, seconds apart. Each submission gets its own order id and often its own payment authorization, so the store owner ends up with two Pending or Awaiting Payment orders for one real purchase.

This job lists recent orders still awaiting fulfillment, groups the ones that share a customer, a product signature, and a total within a short time window, keeps the earliest order in each group, and cancels the rest with `PUT /v2/orders/{id}` (`status_id: 5`), but only after re-checking `GET /v2/orders/{id}/transactions` to make sure the order being cancelled has no captured payment.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/duplicate-orders-from-a-double-submit/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="..."
export DUPLICATE_WINDOW_SECONDS="300"
export LOOKBACK_MINUTES="15"
export DRY_RUN="true"

python duplicate-orders-from-a-double-submit/python/find_duplicate_orders.py
node   duplicate-orders-from-a-double-submit/node/find-duplicate-orders.js
```

`find_duplicate_order_groups` / `findDuplicateOrderGroups` is a pure function that only groups and clusters plain order records, no network calls, so it is fully unit-testable with fixed timestamps. The only write is cancelling a duplicate order's `status_id`, and only after a fresh check for a captured transaction. Start with `DRY_RUN=true` to review the list first. Orders with a captured or authorized transaction are never auto-cancelled; they are flagged for a manual refund and then cancel.

## Test

```bash
pytest duplicate-orders-from-a-double-submit/python
node --test duplicate-orders-from-a-double-submit/node
```
