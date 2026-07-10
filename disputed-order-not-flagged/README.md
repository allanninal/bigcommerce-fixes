# Disputed order not flagged

A chargeback happens between the customer's bank, the card network, and the payment gateway. BigCommerce is not part of that conversation, so an order's status_id only reaches 13 (Disputed) if a webhook happens to arrive and a listener happens to catch it, or a person opens the order and sets it by hand. Many gateways never send that event to BigCommerce at all, so a genuinely disputed order can sit at its old status indefinitely while the payout is already being reduced. This job lists recent orders, reads each order's transactions, and flags only the ones with a clear dispute or chargeback marker in a transaction's type or status, skipping any order already in a settled status such as Disputed, Refunded, Cancelled, or Partially Refunded. It never touches refunds, cancellations, or fulfillment.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/disputed-order-not-flagged/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python disputed-order-not-flagged/python/flag_disputed_orders.py
node   disputed-order-not-flagged/node/flag-disputed-orders.js
```

`needs_dispute_flag` (`needsDisputeFlag` in Node) is a pure function that takes only a status_id and a list of transactions, so it is fully testable without a network call. It only returns true when a transaction's type or status clearly reads as a dispute or chargeback, and the order is not already in a settled status (Disputed, Refunded, Cancelled, Partially Refunded). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest disputed-order-not-flagged/python
node --test disputed-order-not-flagged/node
```
