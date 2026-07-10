# Orders stuck on Awaiting Payment after capture

BigCommerce order status and payment status are decoupled from the real gateway transaction. When a payment is authorize only, capturing it sets payment_status to Pending Capture while the gateway processes the capture out of band. If the confirmation callback is slow, silently fails, or the merchant captures directly in the gateway's own dashboard, the order record never gets the follow up update and status_id stays at 7 (Awaiting Payment) even though the money was actually captured. This job lists candidate orders at status_id 7, reads each order's transactions, and advances only the ones with an unambiguous successful capture or sale transaction whose amount matches the order total to status_id 11 (Awaiting Fulfillment). Anything ambiguous (pending, declined, or a mismatched amount) is flagged for manual review instead of being auto-advanced.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/orders-stuck-on-awaiting-payment-after-capture/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export DRY_RUN="true"

python orders-stuck-on-awaiting-payment-after-capture/python/advance_captured_orders.py
node   orders-stuck-on-awaiting-payment-after-capture/node/advance-captured-orders.js
```

`decide_order_repair` (`decideOrderRepair` in Node) is a pure function that takes only a status_id, a list of transactions, and the order total, so it is fully testable without a network call. It only returns `advance_to_awaiting_fulfillment` when a capture or sale transaction is unambiguously successful and its amount matches the order total within a small epsilon. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest orders-stuck-on-awaiting-payment-after-capture/python
node --test orders-stuck-on-awaiting-payment-after-capture/node
```
