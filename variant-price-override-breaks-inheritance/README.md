# Variant price override stops following base product price changes

A BigCommerce variant's price field is nullable and independent of the parent product's price. If it is null, the storefront falls back to the product's default price, but once a merchant or an API call sets an explicit numeric value on that variant, it decouples permanently. A later PUT that updates the product's price never cascades to variants that already carry a non-null price, sale_price, or retail_price, and the API returns 200 with no warning that variants were left behind. This job pages the full catalog with variants included, compares each variant's price against its product's price using Decimal arithmetic, and writes a report of every divergence for merchant review. A diverging variant price can be intentional (a size or material upcharge), so nothing is reset automatically, only variant ids the merchant explicitly confirms are ever cleared back to null, and even that is gated behind DRY_RUN.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/variant-price-override-breaks-inheritance/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python variant-price-override-breaks-inheritance/python/find_stale_variant_prices.py
node   variant-price-override-breaks-inheritance/node/find-stale-variant-prices.js
```

Both scripts write `stale_variant_overrides.json` and `stale_variant_overrides.csv` in the current directory with one row per divergent variant: `product_id`, `product_name`, `product_price`, `variant_id`, `variant_sku`, `variant_price`, `delta`. To reset specific variants back to inheriting the product price, pass their confirmed variant ids as arguments, for example `python find_stale_variant_prices.py 1234 5678`. Start with `DRY_RUN=true` to see what would be reset before it writes anything.

`find_stale_variant_overrides` (`findStaleVariantOverrides` in Node) is a pure function that takes only a product's id and price plus a list of variants, and returns every variant whose non-null price differs from the product price beyond a small epsilon. It does no I/O, so it is fully testable without a network call or a BigCommerce store.

## Test

```bash
pytest variant-price-override-breaks-inheritance/python
node --test variant-price-override-breaks-inheritance/node
```
