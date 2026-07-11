# Status change skips side effect actions like capture or void

BigCommerce's admin Action menu, Refund, Void transaction, Capture funds, is what actually calls the payment gateway. status_id is updated only as a side effect after that gateway call succeeds. status_id itself is a plain label on the order record with no hook back into the gateway, so writing it directly with `PUT /v2/orders/{id}` changes the label instantly but never touches the gateway. An order can read Refunded or Cancelled with no refund or void transaction ever created, and no money ever moved. This job lists candidate orders whose status_id implies a completed payment action (Refunded, Partially Refunded, Cancelled, Shipped, Awaiting Shipment, Completed, Awaiting Fulfillment), reads each order's transactions, and flags any order whose implied action, a refund, a void, or a capture, has no matching successful transaction to back it up. It never writes status_id and never calls a payment action on its own.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/status-change-skips-payment-side-effects/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export CANDIDATE_STATUS_IDS="4,5,10,14"
export DRY_RUN="true"

python status-change-skips-payment-side-effects/python/find_status_without_payment_action.py
node   status-change-skips-payment-side-effects/node/find-status-without-payment-action.js
```

`find_status_without_payment_action` (`findStatusWithoutPaymentAction` in Node) is a pure function that takes only an order dict and a list of transactions, so it is fully testable without a network call. It only counts transactions with status "ok" as real side effects, and only returns a violation code, `MISSING_REFUND`, `MISSING_VOID`, or `MISSING_CAPTURE`, when the order's status_id implies a payment action that the transaction log does not back up. This is a detect-and-report tool by design; it never auto-repairs. If a flagged order turns out to be a genuine gap, remediate with the dedicated Payment Actions endpoints (`payment_actions/capture`, `payment_actions/void`, `payment_actions/refund_quotes` then `payment_actions/refunds`), never by rewriting status_id, and only after a human has approved the specific order_id.

## Test

```bash
pytest status-change-skips-payment-side-effects/python
node --test status-change-skips-payment-side-effects/node
```
