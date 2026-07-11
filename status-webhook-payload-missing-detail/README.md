# Status webhook payload carries only an id, hiding dropped updates

The `store/order/statusUpdated` webhook's `data` object carries only `{"type":"order","id":<order_id>}`, never the resulting `status_id`. Consumers are required to make a follow-up `GET /v2/orders/{id}` to learn what actually changed. If that follow-up GET fails, times out, hits a rate limit, or the app crashes before it completes, the status change is dropped with nothing left to retry from, because a webhook BigCommerce delivered successfully (200 OK) is never resent even if your own internal follow-up call fails afterward. This job keeps a local last-known `status_id` per order, lists every order modified since the last successful pass, diffs their `status_id` against local state, and re-fetches each mismatch from BigCommerce so a human or a re-sync can repair the local shadow copy. It never writes a status back to BigCommerce.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/status-webhook-payload-missing-detail/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export RECONCILE_LOOKBACK_HOURS="24"
export DRY_RUN="true"

python status-webhook-payload-missing-detail/python/reconcile_order_status.py
node   status-webhook-payload-missing-detail/node/reconcile-order-status.js
```

`diff_order_status` (`diffOrderStatus` in Node) is a pure function that takes only a map of locally known `status_id` values and a list of freshly fetched orders, so it is fully testable without a network call. It flags an order when there is no local record at all, or when the local record disagrees with the order's current `status_id`. Start with `DRY_RUN=true` to review the list first; the job never calls `PUT /v2/orders/{id}`, it only ever updates its own local shadow copy of status_id.

## Test

```bash
pytest status-webhook-payload-missing-detail/python
node --test status-webhook-payload-missing-detail/node
```
