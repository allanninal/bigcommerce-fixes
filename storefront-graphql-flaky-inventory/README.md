# Storefront GraphQL variant inventory returns flaky values

The BigCommerce Storefront GraphQL API serves `inventory.aggregated.availableToSell` through cached response layers, CDN edge caching plus storefront-side caching such as a Next.js data cache or an Apollo client cache, so a query can return a snapshot computed before a very recent stock adjustment has propagated. This is compounded by multi-location aggregation: aggregated stock reflects only the store's default location by default, so an adjustment at a non-default or newly enabled location can leave the Storefront API's aggregated figure permanently out of step with the Management API's true total. This job pulls each variant's true `inventory_level` from the REST Management API, pulls the same variant's `availableToSell` from the Storefront GraphQL API, and diffs them. A nonzero delta is re-polled after a short delay so ordinary cache staleness (which converges) can be told apart from a persistent misconfiguration (which never converges). A persistent, stable mismatch is flagged for manual review, and only in `DRY_RUN=false` mode is the variant's own `inventory_level` corrected to match the confirmed Management API truth, never a value inferred from GraphQL.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/storefront-graphql-flaky-inventory/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export BIGCOMMERCE_STOREFRONT_TOKEN="your_storefront_token"
export PRODUCT_IDS="101,102,103"
export MIN_STABLE_POLLS="2"
export POLL_DELAY_SECONDS="45"
export DRY_RUN="true"

python storefront-graphql-flaky-inventory/python/reconcile_variant_inventory.py
node   storefront-graphql-flaky-inventory/node/reconcile-variant-inventory.js
```

`diff_variant_stock` (`diffVariantStock` in Node) is a pure function that takes only the GraphQL `availableToSell`, the REST `inventory_level`, the variant's `warning_level`, and how many consecutive polls have shown the same delta, so it is fully testable without a network call. It returns `in_sync` when the two numbers match, `transient` for a mismatch seen for the first time, and `flag` only once the mismatch has held across `min_stable_polls` consecutive checks. Start with `DRY_RUN=true` to review the flagged list first; the only write this script ever makes is a targeted correction of a variant's own `inventory_level` back to the confirmed Management API truth.

## Test

```bash
pytest storefront-graphql-flaky-inventory/python
node --test storefront-graphql-flaky-inventory/node
```
