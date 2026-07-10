# Variant inventory not tracked

`inventory_tracking` on a BigCommerce product is a tri-state setting, `"none"`, `"product"`, or `"variant"`, and it is set independently of whether the product actually has variants. A product can have real size or color SKUs, each with its own `inventory_level`, while `inventory_tracking` is still left at `"none"` or set to `"product"` instead of `"variant"`. In that state BigCommerce's checkout and order pipeline never reads or decrements the per-SKU stock, so a variant can sell indefinitely no matter what number the admin displays. This is a classic phantom stock bug that surfaces as an oversold or backordered variant.

This job scans every product with `GET /v3/catalog/products?include=variants`, classifies each one with a pure function, and for products that need a fix, checks whether every affected variant already has a non-null `inventory_level`. If so, it is safe to flip `inventory_tracking` to `"variant"` with a single `PUT /v3/catalog/products/{product_id}`, since the existing per-variant stock numbers become authoritative immediately. If any affected variant has no stock count yet, the product is only flagged for a human to set a real starting count first. It never auto-repairs that case, since enabling tracking on a missing count would falsely show zero stock and block real sales.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/variant-inventory-not-tracked/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python variant-inventory-not-tracked/python/fix_variant_inventory_tracking.py
node   variant-inventory-not-tracked/node/fix-variant-inventory-tracking.js
```

`classify_variant_tracking` (Python) and `classifyVariantTracking` (Node) are pure functions that take a product with its `inventory_tracking` value and its list of variants, and return whether it needs a fix, why, and which variant ids are affected. They never touch the network, so they are fully testable. `all_variants_have_stock` / `allVariantsHaveStock` is the safety guard that decides whether a flagged product is safe to auto-repair or should only be flagged. Start with `DRY_RUN=true` to review the repair list and the flagged list before it writes anything.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest variant-inventory-not-tracked/python
node --test variant-inventory-not-tracked/node
```
