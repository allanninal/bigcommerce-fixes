# Concurrent refund requests on one order corrupt payment status

BigCommerce's refund workflow is two sequential calls per order, `POST /v3/orders/{id}/payment_actions/refund_quotes` to compute the refundable amount and eligible payment methods, then `POST /v3/orders/{id}/payment_actions/refund` using that quote. Refund settlement against the gateway is asynchronous, so payment_status and status_id (Refunded=4, Partially Refunded=14) update after the API accepts the request, not atomically with it. BigCommerce's own documentation states that processing multiple concurrent refunds on the same order is not yet supported, because there is no per-order idempotency lock at the API layer. When two refund requests race for the same order_id, for example a support agent double-clicking Refund while an automation script fires the same request, both can read the same pre-refund quote and both get accepted, leaving the order's payment_status mismatched against the real sum of refund transactions.

This script does two things. First, it wraps future refund calls in a per-order lock so a second request for the same order_id queues instead of racing. Second, it scans orders already at status_id 4 or 14 and reconciles total_refunded against the actual sum of refund transactions, flagging any duplicate submission or mismatch for a human. It never writes a compensating refund or credit automatically, because BigCommerce has no undo-refund endpoint and a second programmatic refund on an already-corrupted order risks a real second charge reversal.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/concurrent-refunds-same-order/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export REFUND_LOCK_TIMEOUT_SECONDS="30"
export DRY_RUN="true"

python concurrent-refunds-same-order/python/reconcile_refund_state.py
node   concurrent-refunds-same-order/node/reconcile-refund-state.js
```

`reconcile_refund_state` (`reconcileRefundState` in Node) is a pure function that takes only the order's total_inc_tax, its reported total_refunded, and a list of refund transactions, so it is fully testable without a network call. It groups transactions by gateway_transaction_id, or by amount plus a close date_created, to catch a duplicate submission, and compares the reported total against the actual sum of refund transactions to catch a mismatch. It returns `"ok"`, `"flag_duplicate"`, or `"flag_mismatch"`, never a write. `refund_order_serialized` (`refundOrderSerialized` in Node) is the only place that calls the refund endpoints, and it acquires a lock keyed by order_id first so a second concurrent call for the same order waits or times out instead of racing. Start with `DRY_RUN=true` to review the flagged report first.

## Test

```bash
pytest concurrent-refunds-same-order/python
node --test concurrent-refunds-same-order/node
```
