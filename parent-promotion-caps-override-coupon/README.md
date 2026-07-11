# Parent promotion max_uses overrides a coupon's own usage cap

In BigCommerce's Promotions v3 model, a coupon code is a child resource nested under a parent Promotion (`/v3/promotions/{promotionId}/codes/{codeId}`), and both levels carry independent `max_uses`/`current_uses` counters. BigCommerce enforces both at checkout, and the promotion-level cap is the outer gate: even if a code's own `max_uses` has plenty of headroom, the shopper gets "invalid coupon code" once the parent promotion's aggregate `current_uses` reaches its `max_uses`. This job lists every ENABLED promotion, pages its coupon codes, and flags any code where the promotion is already exhausted or where the code's own remaining uses exceed what the promotion has left. It never writes to a promotion's cap by default, because raising a merchant's deliberate cap is a business decision, not a bug.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/parent-promotion-caps-override-coupon/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python parent-promotion-caps-override-coupon/python/find_capped_promotion_codes.py
node   parent-promotion-caps-override-coupon/node/find-capped-promotion-codes.js
```

By default the script only reports, it never writes. If you want it to also propose raising a promotion's `max_uses` so it is at least as high as its child codes, pass `--apply`. It still only prints the proposed diff unless `DRY_RUN=false` as well:

```bash
python parent-promotion-caps-override-coupon/python/find_capped_promotion_codes.py --apply
node   parent-promotion-caps-override-coupon/node/find-capped-promotion-codes.js --apply
```

`find_capped_out_codes` (`findCappedOutCodes` in Node) is a pure function that takes only a promotion dict and a list of code dicts, so it is fully testable without a network call. It treats `max_uses == 0` as unlimited, matching how BigCommerce treats zero on this field, and classifies each code as `promotion_exhausted`, `promotion_cap_lower_than_code`, or `ok`.

## Test

```bash
pytest parent-promotion-caps-override-coupon/python
node --test parent-promotion-caps-override-coupon/node
```
