# Ship to multiple addresses produces inconsistent line item to address mapping

BigCommerce's multi-address checkout represents each shipping destination as its own consignment object holding its own line_items (item_id and quantity), and the storefront or headless client is responsible for calling assignItemsToAddress or unassignItemsToAddress (or POST/PUT `/checkouts/{id}/consignments`) once per address as the shopper works through the flow. Because these are sequential, independent calls against a mutable checkout resource with optimistic-concurrency version checks, a slow network, a retried request, or a client that does not re-fetch checkout state between calls can leave an item duplicated across consignments or unassigned to any of them by the time the checkout converts to an order. Once converted, each order line item is stamped with a single order_address_id, so the drift becomes a permanent, silent mismatch. This job never repairs the mapping. It reports drift per product_id by cross-tabbing `GET /v2/orders/{id}/products` against `GET /v2/orders/{id}/shipping_addresses` (and, pre-conversion, `GET /v3/checkouts/{id}/consignments`), and for open orders (status_id 0 or 1) with unassigned quantity it can flag the order for manual verification (status_id 12) so a human reviews it before it ships.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/multi-address-checkout-consignment-drift/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export DRY_RUN="true"

python multi-address-checkout-consignment-drift/python/find_consignment_drift.py
node   multi-address-checkout-consignment-drift/node/find-consignment-drift.js
```

`find_consignment_drift` (`findConsignmentDrift` in Node) is a pure function that takes only a list of pre-conversion consignments and a list of post-conversion order line items, so it is fully testable without a network call. It returns one drift record per product_id with `expected_qty`, `actual_qty`, `unassigned_qty`, `duplicated_qty`, and a `status` of `"unassigned"`, `"duplicated"`, or `"ok"`. The job never rewrites consignments or reassigns a converted order's line items; the only write it makes is flipping an open order's status_id to 12 (Manual Verification Required) when unassigned quantity is found. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest multi-address-checkout-consignment-drift/python
node --test multi-address-checkout-consignment-drift/node
```
