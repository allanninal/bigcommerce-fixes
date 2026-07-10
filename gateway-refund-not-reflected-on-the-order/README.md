# Gateway refund not reflected on the order

BigCommerce only updates an order's `status_id` and writes a refund transaction record when a refund is initiated through its own admin Refund action, or the v3 `payment_actions/refunds` endpoint, which calls the gateway and updates the order atomically. If a merchant or the payment processor issues the refund directly in the gateway's own dashboard or API, there is no callback path into BigCommerce, so the order silently stays at its prior `status_id` even though the customer has already been refunded. This job reads each order's total, its `status_id`, BigCommerce's own recorded refund amount (from `GET /v2/orders/{id}/transactions` and `GET /v3/orders/{order_id}/payment_actions/refunds`), and the gateway's refunded amount, then sets `status_id` to 4 (Refunded) or 14 (Partially Refunded) when the gateway shows an unrecorded refund, or flags the order for manual review when the amounts do not reconcile cleanly. Every write is paired with an order note documenting the gateway refund id, amount, and timestamp, because BigCommerce has no endpoint to retroactively import a gateway-executed refund as if it went through the Refund action.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/gateway-refund-not-reflected-on-the-order/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export REFUND_ROUNDING_TOLERANCE="0.01"
export REVIEW_TAG="gateway-refund-needs-review"
export DRY_RUN="true"

python gateway-refund-not-reflected-on-the-order/python/sync_gateway_refunds.py
node   gateway-refund-not-reflected-on-the-order/node/sync-gateway-refunds.js
```

Wire your payment gateway's own refund lookup (Stripe, Braintree, Authorize.net, etc.) into `gateway_refunded_amount` / `gatewayRefundedAmount` before running for real; both scripts skip orders and log at debug level until that seam is filled in, so nothing is written by accident. `decide_refund_status` / `decideRefundStatus` is a pure function that takes the order total, current `status_id`, the gateway's refunded amount, and BigCommerce's already-recorded refund amount, and returns the action to take. It never guesses: an inconsistent gateway amount (negative, or beyond the order total past a rounding tolerance) is always flagged for manual review instead of applied. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest gateway-refund-not-reflected-on-the-order/python
node --test gateway-refund-not-reflected-on-the-order/node
```
