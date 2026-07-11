# Category image_file field rejected as invalid on update

BigCommerce's V3 Catalog Categories JSON endpoint (`PUT /v3/catalog/categories`) only accepts `image_url` for setting or replacing a category's image. `image_file` is a real field, but it belongs to the separate multipart/form-data endpoint, `POST /v3/catalog/categories/{category_id}/image`, which needs `Content-Type: multipart/form-data`, not JSON. A sync script that PUTs `image_file` as JSON to the categories endpoint gets a 400, "the field 'image_file' is invalid", because that resource's schema has no such property. This job lists categories, compares each one's `image_url` against a source-of-truth image source, and repairs it with the correct call for whatever source is available: `image_url` as JSON when a public URL exists, or `image_file` as multipart when only a local file exists. A category with neither is flagged for manual review instead of being guessed at.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/category-image-file-rejected/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python category-image-file-rejected/python/repair_category_images.py
node   category-image-file-rejected/node/repair-category-images.js
```

`choose_image_repair_strategy` (`chooseImageRepairStrategy` in Node) is a pure function that takes only the category's current state and the available image source, so it is fully testable without a network call. It never pairs the JSON `put_image_url` action with the `image_file` field, that pairing is exactly the 400-triggering bug this fix guards against. Start with `DRY_RUN=true` to review the planned repairs first.

## Test

```bash
pytest category-image-file-rejected/python
node --test category-image-file-rejected/node
```
