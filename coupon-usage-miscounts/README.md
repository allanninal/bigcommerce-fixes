# Coupon usage miscounts

BigCommerce increments a coupon's `num_uses` on `/v2/coupons` the instant an order is placed with that code applied. It never decrements it when the order is later cancelled, declined, refunded, or manually edited or deleted, because `num_uses` is documented as a read-only, system-maintained field that cannot be corrected through a PUT or POST. The stored count drifts upward relative to real usage until it collides with `max_uses` or `max_uses_per_customer` and blocks a legitimate customer.

This job pages `GET /v2/coupons` for every coupon's reported `num_uses`, pages `GET /v2/orders` plus `GET /v2/orders/{id}/coupons` to find every order that ever carried each code, keeps only the orders whose `status_id` represents a real completed or in-progress sale, and reconciles the two numbers with a pure function. It never writes to `num_uses`. The default action is to flag drifted coupons to a review queue. A destructive delete-and-recreate reset that zeroes usage is available only behind an explicit `--confirm` flag, off by default.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/coupon-usage-miscounts/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"
export MIN_DATE_CREATED="2026-01-01T00:00:00"   # optional, narrows the order scan

python coupon-usage-miscounts/python/reconcile_coupon_usage.py
node   coupon-usage-miscounts/node/reconcile-coupon-usage.js
```

Add `--confirm` only if you have accepted that a drifted coupon's usage history resets to zero:

```bash
python coupon-usage-miscounts/python/reconcile_coupon_usage.py --confirm
node   coupon-usage-miscounts/node/reconcile-coupon-usage.js --confirm
```

`reconcile_coupon_usage` (Python) and `reconcileCouponUsage` (Node) are pure functions that take one coupon's reported usage and the full list of orders that ever carried its code, and return `{coupon_id, code, reported_uses, true_uses, delta, drifted, offending_order_ids}`. `true_uses` counts only orders whose `status_id` is in the valid set (2 Shipped, 3 Partially Shipped, 7 Awaiting Payment, 8 Awaiting Pickup, 9 Awaiting Shipment, 10 Completed, 11 Awaiting Fulfillment). Everything else, including 0 Incomplete, 5 Cancelled, 6 Declined, 4 Refunded, and 14 Partially Refunded, is treated as inflation and listed in `offending_order_ids`. They never touch the network, so they are fully testable. Start with `DRY_RUN=true` to review the drift report before anything writes.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest coupon-usage-miscounts/python
node --test coupon-usage-miscounts/node
```
