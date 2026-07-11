# Order update call recalculates and overwrites a coupon adjusted total

BigCommerce's V2 Orders API treats `coupon_discount` as a read-only, server-derived value, calculated from the `/v2/orders/{id}/coupons` sub-resource and each line item's `applied_discounts`, not stored as an independently editable field on the order record. When a PUT to `/v2/orders/{id}` changes any total-affecting property, line items, subtotal or total fields, shipping, handling, wrapping, or fees, BigCommerce recalculates the order's totals from the current line items and cost fields, and the PUT request clears all discounts and promotions applied to the changed order line items. Because there is no writable `coupon_discount` field to resend, a PUT aimed at an unrelated field like `staff_notes` can silently zero out a previously applied coupon discount. This job diffs each modified order against a stored known-good snapshot and the live coupons sub-resource, and reports the orders where the discount no longer reconciles. Report only by default, never an unattended auto-fix.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-update-overwrites-coupon-total/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export DRY_RUN="true"
export ALLOW_WRITE="false"

python order-update-overwrites-coupon-total/python/detect_coupon_overwrite.py
node   order-update-overwrites-coupon-total/node/detect-coupon-overwrite.js
```

`detect_coupon_overwrite` (`detectCouponOverwrite` in Node) is a pure function that takes only a snapshot, the live order state, and the active coupon list, so it is fully testable without a network call. It only returns `is_corrupted: True` when an active coupon's discount should still apply but the live order's total did not fall by a matching amount. Wire `load_snapshot`/`loadSnapshot` up to your own snapshot store (recorded right after checkout or the `store/order/created` webhook) before running against a real store. Start with `DRY_RUN=true` and leave `ALLOW_WRITE=false` to review the flagged list first; only the single sanctioned corrective PUT (resending `total_ex_tax` and `total_inc_tax` together) runs when both are explicitly enabled.

## Test

```bash
pytest order-update-overwrites-coupon-total/python
node --test order-update-overwrites-coupon-total/node
```
