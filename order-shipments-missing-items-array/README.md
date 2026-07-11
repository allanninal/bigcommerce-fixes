# Order shipments response drops the items array

BigCommerce's V2 shipment object, from `GET /v2/orders/{order_id}/shipments`, nests the shipped order lines inside an `items` array of `order_product_id`, `product_id`, and `quantity`, alongside flat scalar fields like `tracking_number` and `order_address_id`. Client integrations that map the response through a fixed schema, a typed model or DTO, or a column-style allowlist built for the common scalar fields can easily leave `items` out, since it is a nested array and not a top-level scalar. The mapped object then shows `items` as missing, null, or an empty list even though the raw JSON body still has the shipped lines. This is a client-side parsing defect, not corrupted BigCommerce data, so this job never writes to the shipment. It only reports the drift and, when `DRY_RUN` is false, cross-checks the raw shipped quantities against `GET /v2/orders/{order_id}/products` to confirm the shipped lines are real.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-shipments-missing-items-array/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export ORDER_IDS="101,102,103"
export DRY_RUN="true"

python order-shipments-missing-items-array/python/find_shipment_items_drift.py
node   order-shipments-missing-items-array/node/find-shipment-items-drift.js
```

`find_items_drift` (`findItemsDrift` in Node) is a pure function that takes only a raw shipment and a mapped shipment, so it is fully testable without a network call. It only returns a drift record when the raw `items` array is non-empty but the mapped object's `items` is missing, null, an empty list, or not a list at all. Start with `DRY_RUN=true`; it only ever reports, it never writes to a shipment, since there is nothing to fix on BigCommerce's side.

## Test

```bash
pytest order-shipments-missing-items-array/python
node --test order-shipments-missing-items-array/node
```
