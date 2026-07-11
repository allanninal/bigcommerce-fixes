# Stale customer group cached in checkout state after a mid session change

BigCommerce's checkout-sdk-js reads a shopper's customer_group_id once when checkout state initializes and caches it in the in-memory checkoutState.data customer object. If the customer_group_id changes mid session (an admin moves the shopper to a new group, a B2B company-role change fires, or an automated group reassignment runs), the SDK's state-merge logic does not reliably overwrite the cached value, documented upstream as checkout-sdk-js issue #1321. Because customer-group pricing is resolved through Price Lists tied to a customer_group_id, and that resolution happens against the cached session group rather than being re-fetched at price-calculation or order-submit time, the shopper can complete checkout priced under their old, stale group. This job walks recent orders, resolves what the customer's CURRENT group's price list would charge, and flags the ones that do not reconcile. It never changes price, issues a refund, or moves order status. It is flag and report only.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/stale-customer-group-in-checkout-state/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export CHANNEL_ID="1"
export DRY_RUN="true"

python stale-customer-group-in-checkout-state/python/flag_stale_group_orders.py
node   stale-customer-group-in-checkout-state/node/flag-stale-group-orders.js
```

`is_order_mispriced` (`isOrderMispriced` in Node) is a pure function that takes the customer's current customer_group_id, the group id inferred from the price-list record that matches what was actually charged, the charged unit price, and the unit price the customer's current group would produce, so it is fully testable without a network call. It returns True only when the group ids actually diverge AND that divergence produced a real price difference beyond a rounding tolerance, so two different groups that happen to share identical pricing are never flagged. Start with `DRY_RUN=true` to review the CSV export first. With `DRY_RUN=false` it additionally appends a staff-only note to each flagged order via `PUT /v2/orders/{id}`. Any actual price adjustment, refund, or status change (for example to status_id 12, Manual Verification Required) is a separate, explicitly-confirmed human action, never automated by this script.

## Test

```bash
pytest stale-customer-group-in-checkout-state/python
node --test 'stale-customer-group-in-checkout-state/node/*.test.js'
```
