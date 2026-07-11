# Brand update immediately before product create returns empty reply

BigCommerce enforces a per-store request quota (150 to 450 requests per 30 second OAuth window depending on plan) and a concurrency cap, normally surfaced as a 429 with `X-Rate-Limit-Requests-Left` and `X-Rate-Limit-Time-Reset-Ms` headers. When a brand `PUT /v3/catalog/brands/{id}` is fired immediately before a product `POST /v3/catalog/products`, the store's connection sometimes closes before the response finishes, which HTTP clients surface as a generic "Empty reply from server" instead of a structured error. This is a confirmed, reproduced issue in BigCommerce's own bigcommerce-api-php SDK repo (issue #138). The underlying mutation may have actually succeeded server side even though the client received nothing parsable, so blindly retrying risks a duplicate product. This job takes logged (brand update, product create) pairs, confirms whether the brand update actually applied and whether the product already exists, and only retries the create when it is idempotently safe. Anything ambiguous (a stale brand update, or a same-named product whose fields do not match) is flagged for manual review instead of being auto-repaired.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/brand-update-product-create-race/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"
export MAX_ATTEMPTS="5"

python brand-update-product-create-race/python/reconcile_brand_product_race.py
node   brand-update-product-create-race/node/reconcile-brand-product-race.js
```

`decide_action` (`decideAction` in Node) is a pure function that takes only a brand-confirmed flag, a product-exists flag, the current rate limit budget, and the retry attempt count, so it is fully testable without a network call. It only returns `retry_create` when the brand update is confirmed applied and the product is confirmed absent. A stale brand update always returns `flag_manual_review`, never a create. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest brand-update-product-create-race/python
node --test brand-update-product-create-race/node
```
