# Manually overridden order pricing is excluded from promotions

BigCommerce's pricing engine only evaluates automatic and coupon promotions against catalog or price-list-derived prices computed by its own pricing service. When a line item is created with an explicit `price_ex_tax` or `price_inc_tax` override, through the V2 Orders API's server-to-server order creation or the Cart/Checkout Server-to-Server APIs, that price is treated as a manually set custom price, not a catalog price. By default, promotions skip line items with custom pricing. A store-level setting, "Allow promotions to apply on products with custom price overrides" under Settings, Promotions and coupons, has to be turned on before the promotion engine will even consider those line items. Leave it off, the default, and any order built through a price-override integration silently gets $0 promo discount even when an active, matching automatic promotion exists.

This is not safely auto-fixable as a write against a settled order, so the script's default action is flag and report only. It emits a JSON/CSV report of `{order_id, expected_promo_ids, override_amount, recommended_action}` for manual review. Orders in shipped, partially shipped, refunded, completed, or partially refunded status (status_id 2, 3, 4, 10, 14) are always report-only. Orders at Incomplete or Awaiting Payment (status_id 0 or 7) are eligible for a guarded, opt-in repair, but this script only recommends that path, it never PUTs a recomputed discount directly onto an order.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/overridden-order-pricing-excludes-promotions/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export DRY_RUN="true"
export REPORT_PATH="promo_override_report.json"

python overridden-order-pricing-excludes-promotions/python/flag_overridden_pricing_promotions.py
node   overridden-order-pricing-excludes-promotions/node/flag-overridden-pricing-promotions.js
```

`flag_missing_promotion` (`flagMissingPromotion` in Node) is a pure function that takes only the order, its line items, its order coupons, and the active promotion list, so it is fully testable without a network call. It only returns a flag when a line item's `price_ex_tax` differs from its `base_price`, no discount is recorded anywhere on the order, and at least one currently active `AUTOMATIC` promotion exists. Everything else is left alone. Start with `DRY_RUN=true` to review the report first; the script writes a report either way and never mutates an order.

## Test

```bash
pytest overridden-order-pricing-excludes-promotions/python
node --test overridden-order-pricing-excludes-promotions/node
```
