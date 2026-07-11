# Applying an API discount clears existing order discounts

`POST /v3/checkouts/{checkoutId}/discounts` treats manual discounts as a full replacement set, not an additive list. Per BigCommerce's own documentation, calling this endpoint clears out all existing discounts applied to line items, including product- and order-based discounts. A script or integration that posts a new API discount to add a promo therefore silently wipes any coupon discount, automatic promotion, or prior manual discount already reflected on the cart or order, with no merge and no warning in the response body. Because checkout discounts operate on the pre-order checkout resource, not the immutable `/v2/orders/{id}`, the loss happens upstream of order creation, so the placed order already reflects the wrong total with no audit trail pointing to the call that caused it.

This job snapshots a checkout's discount and coupon state before and after any discount POST, diffs the two snapshots with a pure, decimal-safe function, and emits a `DRY_RUN` guarded report for every affected checkout. It never silently re-applies a merged discount list, because the original coupon's validity window, usage counters, and tax recalculation cannot be reliably reconstructed client-side.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/api-discount-clears-existing-discounts/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"
export CHECKOUT_ID="your_checkout_id"
export CART_ID="your_cart_id"

python api-discount-clears-existing-discounts/python/detect_cleared_discounts.py
node   api-discount-clears-existing-discounts/node/detect-cleared-discounts.js
```

`diff_discount_state` (`diffDiscountState` in Node) is a pure function that takes only a before snapshot and an after snapshot, each `{discountIds, couponCodes, totalDiscountedAmount}`, so it is fully testable without a network call. It returns the lost discount ids, lost coupon codes, a decimal-safe total delta, and `isAffected`. If re-application is explicitly authorized (not `DRY_RUN`), the only supported recovery is to re-add the lost coupon with `POST /v3/checkouts/{checkoutId}/coupons` and resubmit the full desired discount set, original plus new, in one `POST /v3/checkouts/{checkoutId}/discounts` call. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest api-discount-clears-existing-discounts/python
node --test api-discount-clears-existing-discounts/node
```
