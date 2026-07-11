# Deleting a product or category leaves a dangling URL with no redirect

BigCommerce only auto-generates a 301 redirect when a product's or category's custom_url changes while the record still exists, the storefront URL-rewrite history feature. Deleting the record outright, through the admin UI or `DELETE /v3/catalog/products/{id}` or `/v3/catalog/categories/{id}`, never gives BigCommerce an old path and a new path to reconcile, so no redirect row is ever written and the old URL 404s indefinitely, silently discarding any link equity, backlinks, and bookmarks pointing at it. This job keeps a snapshot of live product and category custom_url values, diffs the previous snapshot against the ids that are still live to find what was deleted, checks each candidate path against the existing redirects, and upserts a 301 only for the paths that are both confirmed deleted and confirmed uncovered.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/deleted-product-no-redirect/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export BIGCOMMERCE_SITE_ID="1"
export DRY_RUN="true"

python deleted-product-no-redirect/python/repair_deleted_url_redirects.py
node   deleted-product-no-redirect/node/repair-deleted-url-redirects.js
```

`plan_redirects` (`planRedirects` in Node) is a pure function that takes a previous URL snapshot, the set of ids still live, the set of paths already covered by a redirect, and a fallback target, so it is fully testable without a network call. It only returns an upsert record for an id that vanished from the current live set and whose URL is not already redirected. Start with `DRY_RUN=true` to review the plan first, and it writes a fresh URL snapshot after every run so the next run has something to diff against.

## Test

```bash
pytest deleted-product-no-redirect/python
node --test deleted-product-no-redirect/node
```
