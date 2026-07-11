# Product image upload rejects non fully qualified URLs

BigCommerce creates a product image by URL through `POST /v3/catalog/products/{product_id}/images` with a JSON body containing `image_url`, and BigCommerce's own servers fetch that remote file server-side. Because of that server-side fetch, `image_url` must be a fully qualified absolute URL, a scheme (http or https) plus a host. A relative path, a protocol-relative URL, or a bare filename has no scheme or host for BigCommerce's fetcher to resolve, so the request is rejected with a 422 image_url is invalid error. This hits bulk or CSV migration imports the hardest, since the source system often stored image paths relative to its own web root, and the product record is already created before the image call runs, so a failed image row just leaves a real product with zero images and no automatic retry.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/image-upload-rejects-relative-urls/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export SOURCE_BASE_URL="https://cdn.oldstore.example.com"
export DRY_RUN="true"

python image-upload-rejects-relative-urls/python/fix_relative_image_urls.py
node   image-upload-rejects-relative-urls/node/fix-relative-image-urls.js
```

`is_fixable_image_url` (`isFixableImageUrl` in Node) is a pure function that takes only a raw URL and an optional source base URL, so it is fully testable without a network call. It returns `already_valid` when the URL already has a scheme and a host, `fixable` when a relative or protocol-relative URL can be resolved against a valid `source_base_url`, `needs_review` when there is no reliable base to resolve against, and `unsupported_scheme` for anything other than http or https. Only `already_valid` and `fixable` results are retried against the BigCommerce API; everything else is routed to a human review queue instead of being guessed at. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest image-upload-rejects-relative-urls/python
node --test image-upload-rejects-relative-urls/node
```
