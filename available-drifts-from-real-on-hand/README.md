# Available drifts from real on-hand

BigCommerce's storefront "available" number is whatever `inventory_level` currently says on the product or variant record, and that number is only as good as the last write to it. Orders decrement stock, cancellations and refunds are supposed to add it back, and a failed webhook, a mid-flight bulk import through the Inventory API, or a manual admin edit can each leave `inventory_level` out of step with what a warehouse recount shows. BigCommerce's own docs warn that the Inventory API is "not channel aware" and that running Inventory API bulk adjustments in parallel with Catalog or Orders API writes can produce unpredictable, incorrect stock calculations, which is exactly the race that produces silent drift.

This job pulls a counted source of truth (a WMS export, cycle-count CSV, or POS/ERP feed) as `{sku: true_on_hand}`, reads every tracked variant's sku and `inventory_level` from `GET /v3/catalog/products?include=variants`, cross-checks recent order activity so a Cancelled, Declined, Refunded, or Partially Refunded order that was never restocked gets attached as context, and plans a set of absolute inventory adjustments with a pure function. Under `DRY_RUN` it only logs the plan. When `DRY_RUN` is false it submits the batch to `PUT /v3/inventory/adjustments/absolute` and re-reads the variants to confirm the counted value stuck.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/available-drifts-from-real-on-hand/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export BIGCOMMERCE_LOCATION_ID="1"
export DRY_RUN="true"

python available-drifts-from-real-on-hand/python/reconcile_inventory.py
node   available-drifts-from-real-on-hand/node/reconcile-inventory.js
```

`plan_inventory_reconciliation` (Python) and `planInventoryReconciliation` (Node) are pure functions that take the tracked catalog variants, a map of counted on-hand quantities, and a map of recent order flags, and return the list of adjustments to make. They never touch the network, so they are fully testable with fixed maps. A SKU with no counted source of truth is skipped, not guessed. Never run this alongside a concurrent Catalog API or Orders API write on the same SKUs, since BigCommerce explicitly warns concurrent inventory recalculation from multiple APIs can corrupt the result. Start with `DRY_RUN=true` to review the planned adjustments before anything writes.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest available-drifts-from-real-on-hand/python
node --test available-drifts-from-real-on-hand/node/*.test.js
```
