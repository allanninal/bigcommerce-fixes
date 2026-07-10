# Duplicate or missing SKUs

BigCommerce only validates SKU uniqueness at write time: a POST or PUT to `/v3/catalog/products` or its `/variants` sub-resource returns a 422 if the new value collides with an existing one. It never retroactively scans the catalog, so duplicates and blanks that entered through CSV bulk imports, multi-channel or POS/ERP sync tools, or the Admin's Duplicate product action persist undetected. Blank SKUs are common because the `sku` field is optional on product and variant creation, and BigCommerce assigns no default in its place.

This job pages through `GET /v3/catalog/products?include=variants&limit=250` across the full catalog, flattens each product and its variants into SKU records, classifies them with a pure function, and in write mode appends a `custom_fields` marker to each conflicting product or variant so a merchandiser can hand-correct the real value. It never rewrites a SKU itself, since a SKU usually encodes a vendor part number or an external POS/ERP mapping that a guessed value could silently break.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/duplicate-or-missing-skus/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python duplicate-or-missing-skus/python/find_sku_conflicts.py
node   duplicate-or-missing-skus/node/find-sku-conflicts.js
```

`classify_sku_conflicts` (Python) and `classifySkuConflicts` (Node) are pure functions that take a flat list of `{id, parentProductId, sku}` records and return the duplicate groups and the missing ones. They normalize each SKU with a trim and a lower-case before grouping, since BigCommerce matches SKUs case-sensitively at the API level but merchants usually mean two differently cased codes as the same one, and they treat a null, undefined, or whitespace-only SKU as missing rather than a joinable key. They never touch the network, so they are fully testable, and their output is sorted for deterministic assertions. Start with `DRY_RUN=true` to review the conflict table before it writes anything.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest duplicate-or-missing-skus/python
node --test duplicate-or-missing-skus/node
```
