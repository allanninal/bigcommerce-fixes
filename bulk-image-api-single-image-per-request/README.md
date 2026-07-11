# Bulk image API only persists the first image per request

BigCommerce's v3 Catalog API has no batch endpoint for product images. `POST /v3/catalog/products/{product_id}/images` is scoped to create exactly one image resource per call, a single `image_file` (multipart/form-data) or a single `image_url` (application/json), unlike the batch endpoints that exist for products (`PUT /v3/catalog/products`) and variants (`PUT /v3/catalog/products/{product_id}/variants`). Import scripts written by analogy to those batch endpoints, or to the nested `images` array returned by `GET .../products?include=images`, assume the images endpoint also accepts an array. BigCommerce either 422s on the unexpected shape or the client's serializer only encodes the first element, so every image after the first is dropped behind a response that still looks like success. This job reads the persisted images for each product, diffs them against a source manifest, and requeues only the images that are actually missing, one POST per image, never batched.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/bulk-image-api-single-image-per-request/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export SOURCE_MANIFEST_PATH="./import-manifest.json"
export DRY_RUN="true"

python bulk-image-api-single-image-per-request/python/requeue_missing_images.py
node   bulk-image-api-single-image-per-request/node/requeue-missing-images.js
```

The source manifest is a JSON file shaped like:

```json
{
  "products": [
    { "product_id": 123, "images": ["https://cdn.example.com/imports/a.jpg", "https://cdn.example.com/imports/b.jpg"] }
  ]
}
```

`diff_missing_images` (`diffMissingImages` in Node) is a pure function that takes a product's ordered source image list and the `data` array from `GET /v3/catalog/products/{product_id}/images`, and returns exactly the source images whose normalized key (basename or canonical URL) is not present in the persisted set, in source order. It touches no network and no BigCommerce store, so it is fully unit-testable. The script never sends a batch payload to the images endpoint: it always issues one `POST .../images` call per missing image, gated behind `DRY_RUN`, and re-checks the persisted images after each requeue batch to confirm the product is fully reconciled. Start with `DRY_RUN=true` to review the requeue list first.

## Test

```bash
pytest bulk-image-api-single-image-per-request/python
node --test bulk-image-api-single-image-per-request/node
```
