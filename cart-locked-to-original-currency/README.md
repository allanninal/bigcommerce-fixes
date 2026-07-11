# Cart stays locked to its original currency after a currency switch

A BigCommerce cart's transactional currency is fixed at creation time and stored on the cart object as `cart.currency.code`. The REST Cart API has no endpoint to mutate the currency of an existing cart. When a shopper switches the storefront currency selector after items are already in the cart, the storefront only updates the display currency, a cookie or session preference, while the underlying cart and checkout keep transacting in the original currency. This job lists open carts, compares each cart's currency against the shopper's selected currency (falling back to the store's default for untracked guest carts), and flags every mismatch. Carts with a manual discount or draft-order status are excluded from auto-migration and only ever reported, since BigCommerce blocks or alters currency changes on those, and any promotion or gift certificate invalid in the new currency is silently dropped when a new cart is rebuilt.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/cart-locked-to-original-currency/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export CHANNEL_ID="1"
export DRY_RUN="true"

python cart-locked-to-original-currency/python/find_currency_mismatched_carts.py
node   cart-locked-to-original-currency/node/find-currency-mismatched-carts.js
```

`find_currency_mismatched_carts` (`findCurrencyMismatchedCarts` in Node) is a pure function that takes a list of carts, a map of each customer's currently selected storefront currency, and the store's default currency, so it is fully testable without a network call. It flags only carts with at least one line item whose `cart.currency.code` differs from the shopper's selected currency, and augments each flagged cart with `expected_currency` and `has_blocking_discount`. Carts flagged with `has_blocking_discount` are never migrated automatically, only reported. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest cart-locked-to-original-currency/python
node --test cart-locked-to-original-currency/node
```
