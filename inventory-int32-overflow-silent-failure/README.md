# Variant inventory sum silently fails to save past int32 max

BigCommerce's Catalog v3 API stores inventory_level as a 32-bit signed integer with a ceiling of 2147483647, and it enforces that ceiling against the product's summed variant inventory, not just the single variant being written. A write via `PUT /v3/catalog/products/{id}/variants/{variant_id}`, the Update Products batch endpoint, or `POST /v3/inventory/adjustments/absolute|relative` that would push that sum over the ceiling does not get clamped and does not return a validation error. It returns HTTP 200 and the stored inventory_level is left unchanged. This check predicts the overflow before writing using only pre-fetched variant levels, and after every write it re-reads the same variant directly to confirm the value actually changed. Everything it finds is reported, nothing is auto-corrected.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/inventory-int32-overflow-silent-failure/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python inventory-int32-overflow-silent-failure/python/check_inventory_overflow.py
node   inventory-int32-overflow-silent-failure/node/check-inventory-overflow.js
```

`would_overflow_and_be_dropped` (`wouldOverflowAndBeDropped` in Node) is a pure function that takes the pre-fetched list of `(id, level)` variant tuples, the target `variant_id`, and the proposed `new_level`, so it is fully testable without a network call. It sums every other variant's level, adds the proposed new level, and flags the write as unsafe when that projected sum (or the new level alone) exceeds 2147483647. Start with `DRY_RUN=true` to review the report first. Nothing is ever auto-corrected; a flagged mismatch is a question for a human, not an answer the script computes on its own.

## Test

```bash
pytest inventory-int32-overflow-silent-failure/python
node --test inventory-int32-overflow-silent-failure/node
```
