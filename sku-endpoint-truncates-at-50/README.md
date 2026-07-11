# SKUs endpoint truncates at 50 records without paginating

GET /v2/products/{id}/skus and its V3 successor GET /v3/catalog/products/{id}/variants are paginated collection endpoints. When the limit query parameter is omitted, BigCommerce silently defaults it to 50 per page, with a documented maximum of 250. A client that calls the endpoint once, without limit/page and without reading meta.pagination.total_pages, only ever sees the first 50 SKUs or variants for any product that has more, and the response never signals anything was cut off. This job pages through the full product catalog, probes each product's variants with the exact unpaginated call a naive integration would make, flags every product_id where records_fetched == 50 and meta.pagination.total > 50 (the truncation signature), and re-fetches the complete, fully paginated list for each one it flags. It never deletes or rewrites a SKU record; it only corrects the read, and any downstream re-sync is guarded by DRY_RUN.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/sku-endpoint-truncates-at-50/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python sku-endpoint-truncates-at-50/python/reconcile_truncated_skus.py
node   sku-endpoint-truncates-at-50/node/reconcile-truncated-skus.js
```

`is_truncated` (`isTruncated` in Node) is a pure function that takes only a records-fetched count, the limit that was explicitly requested (or None), and `meta.pagination.total`, so it is fully testable without a network call. When no limit was requested, it flags truncation when exactly 50 records came back but the true total is greater than 50. When a limit was requested, it flags truncation when the records fetched fall short of the smaller of the requested limit and the true total. Start with `DRY_RUN=true` to review the affected product_ids first.

## Test

```bash
pytest sku-endpoint-truncates-at-50/python
node --test sku-endpoint-truncates-at-50/node
```
