# Coupon applies_to wiped when max_uses is edited

BigCommerce's legacy V2 Coupons endpoint (`PUT /stores/{store_hash}/v2/coupons/{id}`) treats PUT as a full-object replace, not a true partial patch, for the `applies_to` sub-object. BigCommerce's own docs state that if `applies_to` is not included in the PUT request, its existing value on the coupon will be cleared. A script that sends only `{"max_uses": 50}` to bump a usage cap silently resets `applies_to` back to its default, wiping the coupon's product or category restriction, while the response still shows 200 and every other field intact. This reconciler snapshots every coupon before any write, re-fetches the freshest copy right before each PUT, always composes the PUT body by merging the snapshot into the desired changes (never a bare partial), and verifies with a follow-up GET that `applies_to` survived. If a wipe is detected, it logs (or, with `DRY_RUN=false`, sends) a corrective PUT that resends the snapshotted `applies_to`. Coupons with no prior snapshot are flagged for manual review, never guessed.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/coupon-applies-to-wiped-on-max-uses-edit/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python coupon-applies-to-wiped-on-max-uses-edit/python/reconcile_coupon_applies_to.py
node   coupon-applies-to-wiped-on-max-uses-edit/node/reconcile-coupon-applies-to.js
```

`plan_coupon_update` (`planCouponUpdate` in Node) is a pure function that takes a coupon snapshot and the desired changes, and always returns a full PUT body composed from the snapshot merged with those changes, so untouched fields, especially `applies_to`, are always re-asserted. It also returns `wipeRiskFields`, the list of fields known to be cleared on omission, purely for logging and assertions. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest coupon-applies-to-wiped-on-max-uses-edit/python
node --test coupon-applies-to-wiped-on-max-uses-edit/node
```
