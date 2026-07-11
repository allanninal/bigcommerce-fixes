# Price list has no entry for a variant so it falls back to catalog price

BigCommerce price lists store overrides as flat per-variant records, each keyed by variant_id and currency, not as product-level rules that cascade to child variants. A CSV import, an admin UI edit, or an API batch upsert can easily cover only some of a product's variants, for example just the ones that existed at the time of the last export, and miss newly added variants entirely. Because the pricing engine looks up a record for the exact variant_id being viewed and falls through to standard catalog pricing when nothing matches, the gap is silent: no admin warning, no validation error, no webhook. This job enumerates every active variant storewide, pulls every record from every price list actually assigned to a customer group, and reports every variant missing from an active price list, so merchandising can review and fix the actual gaps.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/price-list-missing-variant-entry/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python price-list-missing-variant-entry/python/price_list_variant_gaps.py
node   price-list-missing-variant-entry/node/price-list-variant-gaps.js
```

`find_variant_price_gaps` (`findVariantPriceGaps` in Node) is a pure function that takes only a set of active variant ids, a list of already-fetched price list records, and a dict mapping customer_group_id to price_list_id, so it is fully testable without a network call. It never invents a price: it only reports the price_list_id, variant_id, and affected_customer_groups for every variant with no record in its group's active price list. A corrective write (`PUT /v3/pricelists/{price_list_id}/records/batch`) only happens if the caller supplies an explicit fallback rule, and even then only when `DRY_RUN=false`.

## Test

```bash
pytest price-list-missing-variant-entry/python
node --test price-list-missing-variant-entry/node
```
