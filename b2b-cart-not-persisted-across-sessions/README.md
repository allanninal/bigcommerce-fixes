# Cart contents lost across devices or sessions in the B2B buyer portal

BigCommerce carts are anonymous by default. A cart is created against a storefront checkout/session cart_id and only gets a customer_id attached when the shopper is logged in at the moment items are added, via a PUT to /v3/carts/{cartId} or storefront session binding. The B2B Buyer Portal has no reliable way to rehydrate a customer's prior cart on a new device or after a fresh login, because the Carts API has no "list carts by customer_id" endpoint, and the portal's SPA state and the storefront cart cookie are both scoped to the browser. Login, logout, and device switches therefore spawn a new anonymous cart_id, and the old cart is simply abandoned until BigCommerce auto-expires it after 30 days without modification. This job rebuilds a {cart_id, customer_id, created_at, updated_at} mapping from your own tracked source, re-reads each cart's live state from the Carts API, groups by customer_id, and classifies duplicates: the most recently updated cart is canonical, an older cart whose items are a subset of the canonical cart is safely deletable, and an older cart with items the canonical cart lacks is flagged for a manual merge, never auto-merged or deleted.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/b2b-cart-not-persisted-across-sessions/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export CART_VALIDITY_DAYS="30"
export DRY_RUN="true"

python b2b-cart-not-persisted-across-sessions/python/reconcile_b2b_carts.py
node   b2b-cart-not-persisted-across-sessions/node/reconcile-b2b-carts.js
```

Both entry points call `load_tracked_cart_ids()` / `loadTrackedCartIds()`, which you must wire up to your own store of tracked cart_ids (checkout redirect events, order logs, or webhook history captured at cart creation time), since BigCommerce has no endpoint to list carts by customer_id.

`classify_cart_duplicates` (`classifyCartDuplicates` in Node) is a pure function that takes only a list of plain cart records, the current epoch time, and a validity window, so it is fully testable without a network call. It drops expired carts, groups the rest by customer_id, picks the most recently updated cart per customer as canonical, and splits every other cart into `orphans_deletable` (a strict subset of the canonical cart's items) or `orphans_needs_merge` (has items the canonical cart does not). Only `orphans_deletable` carts are ever deleted, and only once `DRY_RUN=false` is explicit. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest b2b-cart-not-persisted-across-sessions/python
node --test b2b-cart-not-persisted-across-sessions/node
```
