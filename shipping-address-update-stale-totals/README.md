# Order shipping address update does not recompute tax or shipping cost

BigCommerce's V2 Orders API treats the order shipping address as a plain address record, not a pricing input. `PUT /v2/orders/{id}/shippingaddresses/{address_id}` only writes street/city/zip/country fields and never re-runs the shipping-rate lookup or the tax engine, because both only happen inside cart and checkout consignment flows on `/v3/checkouts`, not on the order object itself. Order-level fields like `base_shipping_cost`, `shipping_cost_ex_tax`/`inc_tax`, and `total_tax` are static snapshots taken at order creation, so editing the address afterward silently desyncs those money fields from the real destination.

This job lists candidate orders, diffs the live shipping address against a saved address hash, and for orders that are still in an editable status (Incomplete, Pending, Awaiting Payment, Awaiting Shipment, Awaiting Fulfillment) with stale totals, builds a fresh checkout consignment quote and a fresh tax estimate, then writes `shipping_cost_ex_tax`, `shipping_cost_inc_tax`, and `total_tax` back together. Orders in a locked status (Shipped, Partially Shipped, Refunded, Cancelled, Declined, Completed, Disputed, Partially Refunded) are always skipped and never auto-repaired.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/shipping-address-update-stale-totals/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export DRY_RUN="true"

python shipping-address-update-stale-totals/python/recompute_stale_totals.py
node   shipping-address-update-stale-totals/node/recompute-stale-totals.js
```

`decide_recompute` (`decideRecompute` in Node) is a pure function that takes only the order, the live shipping address, and a previously cached address hash, so it is fully testable without a network call. It always skips orders in a locked status (Shipped, Refunded, Cancelled, Completed, and similar), and only ever returns `recompute` when the address changed while the cached totals never moved. Start with `DRY_RUN=true` to review the list first; writing a live order's money fields is financially sensitive, so treat the flagged list as something a human reviews before you flip `DRY_RUN=false`.

## Test

```bash
pytest shipping-address-update-stale-totals/python
node --test shipping-address-update-stale-totals/node
```
