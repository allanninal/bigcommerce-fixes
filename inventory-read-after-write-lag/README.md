# Inventory read immediately after write returns stale stock

BigCommerce's Inventory API (`PUT /v3/inventory/adjustments/absolute` or `/relative`) processes writes asynchronously. The call returns 200 with an action id (`data.id`) as soon as the request is accepted into the processing pipeline, not after the new quantity is durably committed and propagated to the read path. BigCommerce's own docs describe this as eventual consistency, with a short delay before data is updated after the endpoints are called, and warn that a relative adjustment can even race against a still-in-flight absolute adjustment's pre-check stage. A GET immediately after a write can therefore return the pre-write quantity with no error or signal that it is stale. This script submits an adjustment, then polls the read endpoint with exponential backoff until the observed quantity matches the expected quantity. If the poll budget runs out, it flags the adjustment for an operator instead of ever calling `/v3/inventory/adjustments` again.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/inventory-read-after-write-lag/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MAX_ATTEMPTS="6"
export BASE_DELAY_S="1.0"
export DRY_RUN="true"

python inventory-read-after-write-lag/python/confirm_inventory_write.py
node   inventory-read-after-write-lag/node/confirm-inventory-write.js
```

`confirm_inventory_write` (`confirmInventoryWrite` in Node) is a pure function that takes only the expected quantity, the last observed quantity, the adjustment id, the current attempt, and the retry budget, so it is fully testable without a network call. It returns `confirmed` when the read matches, `retry` with the next backoff delay when it does not and budget remains, and `stale_flagged` when the adjustment id is missing or the poll budget runs out. Start with `DRY_RUN=true` to review behavior before writing.

## Test

```bash
pytest inventory-read-after-write-lag/python
node --test inventory-read-after-write-lag/node
```
