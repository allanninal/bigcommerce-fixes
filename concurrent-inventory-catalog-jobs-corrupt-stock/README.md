# Concurrent inventory and catalog or order bulk jobs corrupt stock totals

BigCommerce's Inventory API processes absolute and relative adjustments asynchronously through its own internal queue, and its documentation warns that running Inventory API bulk operations in parallel with Catalog API or Orders API bulk operations may cause unpredictable, incorrect calculation results. Relative adjustments do a read-modify-write against the current stored `total_inventory_onhand`, so a catalog bulk edit that also touches `inventory_level`, or an order bulk job decrementing stock, can race an inventory adjustment job on the same SKU and location and silently clobber or double-apply it. BigCommerce does not expose a public adjustment audit-trail endpoint, so this job reconstructs the expected on-hand for each SKU and location from your own adjustment ledger, compares it against what BigCommerce actually reports, and pushes a corrective absolute adjustment only where the two disagree beyond a tolerance, re-verifying every write before marking the SKU reconciled.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/concurrent-inventory-catalog-jobs-corrupt-stock/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export STOCK_TOLERANCE="0"
export DRY_RUN="true"
export JOB_START_TS="2026-07-01T00:00:00Z"

python python/reconcile_concurrent_inventory_drift.py
node   node/reconcile-concurrent-inventory-drift.js
```

Both entry points call `run(job_start_ts, ledger)` (`run(jobStartTs, ledger)` in Node), where `ledger` maps each `(sku, location_id)` pair to the expected on-hand quantity reconstructed from your own persisted adjustment history. BigCommerce does not expose this history, so your integration has to keep it.

`is_inventory_corrupted` (`isInventoryCorrupted` in Node) is a pure function that takes an actual on-hand quantity, an expected on-hand quantity, and a tolerance, and returns whether the SKU should be flagged for repair. `build_correction_payload` (`buildCorrectionPayload` in Node) is a pure function that builds the exact `{location_id, sku, quantity}` item dict for the absolute-adjustment request body. Neither function touches the network, so both are fully testable without a store. Start with `DRY_RUN=true` to review the flagged list first, and always gate future inventory-adjustment jobs and catalog/order bulk jobs behind a single per-`store_hash` mutex so they never overlap again.

## Test

```bash
pytest python
node --test node
```
