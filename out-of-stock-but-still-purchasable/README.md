# Out of stock but still purchasable

BigCommerce only blocks checkout for a SKU when three fields agree: `inventory_tracking` is scoped correctly (`"product"` for simple products or `"variant"` for SKU-level options), the matching `inventory_level` is at or below zero, and `availability` is not forced to `"available"`. A common break is `inventory_tracking` left at `"none"`, or scoped at the product level while stock is really managed per variant. In that state BigCommerce never evaluates stock at all, so the storefront and API accept orders no matter what `inventory_level` says. This job scans every product and variant, flags every "phantom in-stock" record for merchant review, and only writes a correction for a product id a human has explicitly confirmed.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/out-of-stock-but-still-purchasable/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export CONFIRMED_PRODUCT_IDS=""   # comma-separated product ids a human has verified, e.g. "101,204"
export DRY_RUN="true"

python out-of-stock-but-still-purchasable/python/find_stale_in_stock.py
node   out-of-stock-but-still-purchasable/node/find-stale-in-stock.js
```

`is_stale_in_stock` is a pure function that takes only `inventory_tracking`, `inventory_level`, `availability`, and `purchasing_disabled` and returns a bool, so it is fully testable without a network call or a BigCommerce store. The script never mutates live availability on its own: a correction only runs for a product id present in `CONFIRMED_PRODUCT_IDS`, and even then it is guarded by `DRY_RUN` and re-reads the product afterward to confirm the write persisted. Start with `DRY_RUN=true` and an empty `CONFIRMED_PRODUCT_IDS` to review the flagged list first.

## Test

```bash
pytest out-of-stock-but-still-purchasable/python
node --test out-of-stock-but-still-purchasable/node
```
