# Manual status change to Refunded does not move any money

BigCommerce treats order status and money movement as two decoupled systems. The status_id field is just a label on the order record, and PUT /v2/orders/{id} will accept status_id 4 (Refunded) or 14 (Partially Refunded) with no side effect at all. Real refunds only happen through the Payment Actions workflow, refund_quotes then refunds, which calls the gateway and, only on success, writes a transaction and updates status as a result. Staff using the Edit status dropdown instead of the Refund action, or an integration that PUTs status_id 4 directly to mirror an external refund, both leave the order showing Refunded with zero refund transactions behind it. This job lists candidate orders at status_id 4 and 14, reads each order's transactions, and reports every order where no refund-type transaction exists and refunded_amount is still 0.00. There is no BigCommerce API to retroactively attach a real refund to an order, so this never auto-repairs. With DRY_RUN=false it additionally fetches a refund quote and prints the exact refund request an operator would need to review and submit by hand. It never calls the real refunds endpoint itself.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/manual-refunded-status-without-transaction/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python manual-refunded-status-without-transaction/python/find_orphaned_refund_statuses.py
node   manual-refunded-status-without-transaction/node/find-orphaned-refund-statuses.js
```

`is_orphaned_refund_status` (`isOrphanedRefundStatus` in Node) is a pure function that takes only a status_id, a list of transactions, a refunded_amount, and a total_inc_tax, so it is fully testable without a network call. It only returns true when status_id is 4 or 14 and there is no refund-type transaction with a positive amount and refunded_amount is still effectively 0.00. Start with `DRY_RUN=true`; even with `DRY_RUN=false` the job only fetches a refund quote and prints the request an operator must confirm, it never submits the real refund.

## Test

```bash
pytest manual-refunded-status-without-transaction/python
node --test manual-refunded-status-without-transaction/node
```
