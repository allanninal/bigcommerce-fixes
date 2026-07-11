# Duplicating a product creates variants with colliding SKUs

When BigCommerce duplicates a product, in the admin or through a script cloning it via the Catalog API, it copies the full variant option matrix but does not mint new SKU values for the cloned variants. It either repeats the source product's SKU verbatim across every variant row or leaves them blank. BigCommerce only enforces SKU uniqueness as a write-time constraint, a 409 Conflict on save, rather than auto-generating a unique SKU at duplication time, so the copy silently persists with colliding SKUs until something else tries to write or match on one, such as an inventory sync, a bulk edit, or a later manual save. This job walks the catalog, groups each product's variant SKUs, and reports every collision. Renaming is gated behind an explicit `--apply` flag and `DRY_RUN` guard, because a SKU can be keyed against an external inventory or ERP system.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/duplicate-product-creates-colliding-skus/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

# Report only (default): finds and logs every collision, writes sku_collisions.csv
python duplicate-product-creates-colliding-skus/python/fix_colliding_variant_skus.py
node   duplicate-product-creates-colliding-skus/node/fix-colliding-variant-skus.js

# Rename the duplicates within each collision group (keeps the first variant's SKU untouched)
DRY_RUN=false python duplicate-product-creates-colliding-skus/python/fix_colliding_variant_skus.py --apply
DRY_RUN=false node   duplicate-product-creates-colliding-skus/node/fix-colliding-variant-skus.js --apply
```

`find_sku_collisions` (`findSkuCollisions` in Node) is a pure function that takes only a flat list of variant records (`product_id`, `variant_id`, `sku`, `option_values`) and returns the collision groups, so it is fully testable without a network call. It normalizes each SKU with `strip().lower()`, groups by `(product_id, normalized_sku)`, ignores blank SKUs, and keeps only groups with more than one variant. Start with `DRY_RUN=true` and without `--apply` to review the report first.

## Test

```bash
pytest duplicate-product-creates-colliding-skus/python
node --test duplicate-product-creates-colliding-skus/node
```
