# Stale product modifiers after import

BigCommerce's CSV product import and export tools can only edit price and weight adjusters on modifier `option_values` that already exist. They cannot create, delete, or fully re-link one. So when a migration or bulk-import tool deletes and recreates variants with new SKUs and variant IDs, or replaces the product a `product_list` or `product_list_with_images` modifier points at, the old modifier and its option_values survive on the parent product, referencing records that no longer exist. This job pages the catalog, cross-checks every modifier's option_values against the product's current variant SKUs and the live catalog's product ids, and only acts on confirmed orphans.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/stale-product-modifiers-after-import/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python stale-product-modifiers-after-import/python/find_stale_modifiers.py
node   stale-product-modifiers-after-import/node/find-stale-modifiers.js
```

`find_stale_modifiers` is a pure function that takes a product's modifiers, its live variant SKUs, and the set of product ids known to still exist, and returns the stale ones. It never deletes a customer-facing modifier on its own: in write mode the script only deletes a modifier when every option_value is a confirmed dead reference, strips just the dangling entries when some values are still valid, and records anything ambiguous, like a required modifier with zero option_values, in an audit list for a merchant to review instead of writing to the catalog. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest stale-product-modifiers-after-import/python
node --test stale-product-modifiers-after-import/node
```
