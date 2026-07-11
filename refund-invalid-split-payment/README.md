# Refund rejected on orders paid with split payment methods

An order paid with more than one tender, part gift card and part credit card, or store credit plus PayPal, settles as separate transactions against separate payment providers, each capped at what that provider actually captured. The V3 refund endpoint, `POST /v3/orders/{order_id}/payment_actions/refunds`, requires the `payments[].provider_id` and `payments[].amount` in the request to exactly match an entry the gateway already approved in a prior refund quote from `POST /v3/orders/{order_id}/payment_actions/refund_quotes`. It will not automatically split a lump sum refund across tenders. Scripts that skip the quote step, refund against the wrong or stale `provider_id`, refund more than a provider's captured amount, or try to refund the full order total to a single provider all trigger "the requested refund had invalid split payment." This script always requests the quote first and builds the refund payload from the quote's own `refund_methods` array.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/refund-invalid-split-payment/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export ORDER_ID="1234"
export REQUESTED_TOTAL="80.00"
export DRY_RUN="true"

python refund-invalid-split-payment/python/refund_split_payment.py
node   refund-invalid-split-payment/node/refund-split-payment.js
```

`build_split_refund_payload` (`buildSplitRefundPayload` in Node) is a pure function that takes only a refund quote's `refund_methods` array and the requested total, so it is fully testable without a network call. It never lets a single provider's amount exceed that provider's quoted maximum, it orders entries by `provider_id` for determinism, and it raises before anything is posted if the requested total cannot be covered by the quote, whether that is an over-refund attempt or a zero or negative amount. Start with `DRY_RUN=true` to review the computed split first. One order gets one refund call at a time, since BigCommerce does not support concurrent refunds on the same order.

## Test

```bash
pytest refund-invalid-split-payment/python
node --test refund-invalid-split-payment/node
```
