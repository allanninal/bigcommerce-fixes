# Products stranded with no category

A product's `categories` field is just an array of category ids, and nothing about creating a product through `POST /v3/catalog/products` or a bulk import requires that array to be non-empty. When it ships empty, the product saves fine and stays reachable by direct link, but it never appears on any category page, navigation menu, or facet a normal shopper uses to browse. This job scans every product with `GET /v3/catalog/products`, classifies each one with a pure function, and for every stranded product assigns one clearly labeled fallback category with a single `PUT`. It never guesses a specific category from the product name, and it never touches a product that already has at least one category.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/products-stranded-with-no-category/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export FALLBACK_CATEGORY_ID="99"
export DRY_RUN="true"

python products-stranded-with-no-category/python/fix_stranded_products.py
node   products-stranded-with-no-category/node/fix-stranded-products.js
```

`is_stranded` (Python) and `isStranded` (Node) are pure functions that take a product with its `categories` array and return whether it is stranded. They never touch the network, so they are fully testable. Start with `DRY_RUN=true` to review the list of stranded products before it writes anything, and make sure `FALLBACK_CATEGORY_ID` points at a real, clearly labeled holding category you created ahead of time.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest products-stranded-with-no-category/python
node --test products-stranded-with-no-category/node
```
