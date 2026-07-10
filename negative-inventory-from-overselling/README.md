# Negative inventory from overselling

A BigCommerce variant's `inventory_level` is meant to floor at zero, but concurrent checkouts on a low-stock SKU, a bulk import writing a negative delta, or a channel sync double counting a sale can push it below zero. Checkout does not refuse a negative count, so a SKU that reads -3 sells exactly like one that reads 30. This job scans every product's variants, finds the ones with `inventory_level` below zero, and resets each one to zero with `POST /v3/inventory/adjustments/absolute`, keeping the oversold quantity so it can be logged for restock and demand planning.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/negative-inventory-from-overselling/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export ADJUSTMENT_REASON="negative_inventory_overselling_repair"
export DRY_RUN="true"

python negative-inventory-from-overselling/python/fix_negative_inventory.py
node   negative-inventory-from-overselling/node/fix-negative-inventory.js
```

`classify_negative_inventory` / `classifyNegativeInventory` is a pure function that takes a product and one of its variants and decides whether it is a real oversell, so the decision is fully testable without a network call or a BigCommerce store. A negative count on a product that does not track inventory at the variant level is left alone, since it is not a real stock problem. Start with `DRY_RUN=true` to review the list of oversold SKUs first.

## Test

```bash
pytest negative-inventory-from-overselling/python
node --test negative-inventory-from-overselling/node
```
