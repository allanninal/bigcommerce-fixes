# V3 pagination breaks when options or modifiers are included

BigCommerce's v3 catalog/products endpoint documents that when include=options, include=modifiers, or include=variants is requested, the server silently caps the page size at 10 records per page regardless of the limit query param sent, because hydrating those nested sub-resources per product is expensive to join and serialize. meta.pagination.total is still computed correctly, but total_pages is calculated from the same count query used for the plain, un-hydrated list, so it understates how many 10-record pages are actually needed. A client that walks pages until page > meta.pagination.total_pages stops early and silently drops products from the tail of the catalog.

This is a read-side pagination and response-metadata defect in BigCommerce's API, not a data problem on the merchant's catalog, so there is nothing to PATCH or PUT. The fix is to detect the gap with a baseline pull (no include) versus a suspect pull (include=options,modifiers), and to switch the client's stop condition to "loop until data comes back empty" whenever options, modifiers, or variants are included.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/v3-pagination-breaks-with-includes/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export INCLUDE_PARAM="options,modifiers"
export LIMIT="250"
export DRY_RUN="true"

python v3-pagination-breaks-with-includes/python/check_include_pagination.py
node   v3-pagination-breaks-with-includes/node/check-include-pagination.js
```

`reconcile_paginated_product_ids` (`reconcilePaginatedProductIds` in Node) is a pure function that takes a baseline id list and the pages returned by the include pull, so it is fully testable without a network call. It flags `missingIds`, reports whether `total_pages` is `paginationTrustworthy`, and returns the `recommendedStopCondition` a caller should use: `"total_pages"` when it is safe, `"empty_data_array"` when it is not. This script never writes to the catalog, `DRY_RUN` only controls whether the workaround note is printed alongside the report.

## Test

```bash
pytest v3-pagination-breaks-with-includes/python
node --test v3-pagination-breaks-with-includes/node
```
