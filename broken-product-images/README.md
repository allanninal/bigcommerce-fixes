# Broken product images

A BigCommerce product image record on `/v3/catalog/products/{product_id}/images` stores metadata and derived CDN URLs (`url_zoom`, `url_standard`, `url_thumbnail`, `url_tiny`) that point at a file BigCommerce's image service is expected to serve, but the underlying file can go missing while the database row survives. This commonly follows a bulk CSV/V2 import that set `image_url` to a URL that was never truly fetched, a WMS/PIM sync that wrote a row referencing a file deleted or renamed before BigCommerce could pull it, or a botched Stencil/CDN migration or app cleanup that purges files without deleting the matching image records. This job scans every product's images, checks the status of every URL, flags every broken image for merchant review, and only clears or removes a confirmed-dead reference under an explicit write flag.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/broken-product-images/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export REPLACEMENT_URLS=""   # optional "old=>new" pairs, comma-separated, e.g. "https://old/a.jpg=>https://new/a.jpg"
export DRY_RUN="true"

python broken-product-images/python/find_broken_images.py
node   broken-product-images/node/find-broken-images.js
```

`decide_image_action` is a pure function that takes one image record, a mapping of URL to HTTP status code obtained by the caller beforehand, and the sibling images still on the product, and returns `"ok"`, `"flag_only"`, `"clear_reference"`, or `"promote_thumbnail"`. It touches no network and no BigCommerce store, so it is fully unit-testable. The script never deletes an image row on sight: everything is flagged for review by default, and a correction only runs under `DRY_RUN=false`, either self-healing with a `REPLACEMENT_URLS` entry or falling back to a logged delete, and promoting the next image to thumbnail if the one removed was the product's thumbnail. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest broken-product-images/python
node --test broken-product-images/node
```
