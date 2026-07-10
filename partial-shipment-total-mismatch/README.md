# Partial shipment total mismatch

BigCommerce rolls up an order's `status_id` (2 Shipped, 3 Partially Shipped) from summing `quantity_shipped` across its line items on `GET /v2/orders/{id}/products`. Because shipments are created incrementally through separate `POST /v2/orders/{id}/shipments` calls, a duplicated WMS/3PL call, a shipment posted against an already-refunded line, or a dropped webhook retry can push the shipped total above or leave it below the true ordered quantity, and BigCommerce never reconciles it after the fact. This job reads each candidate order's line items and its independent shipment ledger, classifies every line with a pure function, safely corrects `status_id` for the two well-defined stuck-partial cases, and flags every real ledger disagreement or over-fulfillment to `staff_notes` for a human to reconcile against the WMS. It never deletes, edits, or recreates a shipment record.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/partial-shipment-total-mismatch/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export DRY_RUN="true"

python partial-shipment-total-mismatch/python/find_shipment_mismatch.py
node   partial-shipment-total-mismatch/node/find-shipment-mismatch.js
```

`classify_shipment_mismatch` / `classifyShipmentMismatch` is a pure function that takes the ordered quantity, the cached `quantity_shipped`, `quantity_refunded`, the independently summed shipment ledger quantity, and the order's `status_id`, and returns one of `ledger_drift`, `over_fulfilled`, `stuck_partial_done`, `stuck_partial_unshipped`, or `ok`. Only `stuck_partial_done` and `stuck_partial_unshipped` trigger an automatic `status_id` correction; `ledger_drift` and `over_fulfilled` only ever write a `staff_notes` flag. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest partial-shipment-total-mismatch/python
node --test partial-shipment-total-mismatch/node
```
