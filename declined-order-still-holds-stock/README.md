# Declined order still holds stock

BigCommerce decrements inventory_level at order creation or payment authorization time, and only returns that stock automatically when the order reaches a status your Inventory Settings map to "return stock", typically Cancelled or Refunded. Declined (status_id 6) is often not covered by that mapping, or the status change came from a fraud app or payment webhook that bypassed the storefront flow that normally triggers the restock hook. The result is a Declined order sitting with stock still debited, quietly reducing what real buyers can order.

This job lists recently Declined orders, pulls each order's line items and transactions, and classifies it with a pure function. Orders with zero approved or captured transactions get their stock returned through a relative inventory adjustment. Orders where money actually moved despite the Declined status are only flagged for manual review, never auto-restocked, since they may have been manually captured or shipped later.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/declined-order-still-holds-stock/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export RESTOCK_LOOKBACK_DAYS="3"
export LOCATION_ID="1"
export DRY_RUN="true"

python declined-order-still-holds-stock/python/restock_declined_orders.py
node   declined-order-still-holds-stock/node/restock-declined-orders.js
```

`decide_restock` (Python) and `decideRestock` (Node) are pure functions that take an order (`status_id`, its line items, whether it was already adjusted) and its list of transactions, and return `"restock"`, `"flag"`, or `"skip"` along with the items to restock. They never touch the network, so they are fully testable. Start with `DRY_RUN=true` to review the list before it writes anything, and treat every flagged order as a signal to check the gateway by hand.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest declined-order-still-holds-stock/python
node --test declined-order-still-holds-stock/node
```
