# Writing order status text instead of status_id fails or no-ops

BigCommerce's V2 Orders resource models order state as a numeric `status_id`. The `status` field returned by `GET /v2/orders/{id}`, for example "Awaiting Fulfillment", is a read-only label the server computes from that id and the store's Control Panel status-label customization. It is not an independent writable property. Sending `PUT /v2/orders/{id}` with `{"status": "Shipped"}` either gets silently ignored, leaving `status_id` unchanged, or gets rejected if the endpoint validates strictly. It never maps the label back to an id.

This job fetches the store's own `GET /v2/order_statuses` list, builds a case-insensitive name-to-id map, resolves the desired status (an int or a name) through that map with `resolve_status_id`, and writes only `status_id`, never the raw string. Every write is checked against an explicit allowlist of permitted target status ids, and every write is verified by re-fetching the order and retried once on mismatch before being flagged for review.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-status-write-requires-status-id/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export ALLOWED_STATUS_IDS="2,9,10,11"
export DRY_RUN="true"
export ORDER_ID="123"
export DESIRED_STATUS="Shipped"

python order-status-write-requires-status-id/python/write_order_status_id.py
node   order-status-write-requires-status-id/node/write-order-status-id.js
```

`resolve_status_id` (`resolveStatusId` in Node) is a pure function that takes only the desired status (an int, a numeric string, or a name), a status map built from `GET /v2/order_statuses`, and the set of valid ids, so it is fully testable without a network call. It returns an integer `status_id` only when the input resolves unambiguously; anything unresolved returns `None`/`null` and must never be sent to the API as a raw string. Start with `DRY_RUN=true` to review the resolved `{order_id, from_status_id, to_status_id}` triple first.

## Test

```bash
pytest order-status-write-requires-status-id/python
node --test order-status-write-requires-status-id/node
```
