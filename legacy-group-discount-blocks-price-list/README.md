# Legacy customer group discount blocks a price list from attaching

BigCommerce customer groups support two mutually exclusive pricing mechanisms: legacy `discount_rules` (store-wide, category, or product percent, fixed, or price-modifier discounts, set through the V2 Customer Groups API) and V3 Price List assignments. A group can only run one at a time. If `discount_rules` is still non-empty on a group from before Price Lists were adopted, a Price List assignment created with `POST /v3/pricelists/assignments` will not visibly apply at storefront for that group, because the legacy discount takes precedence and the group's pricing representation reverts to `method`/`amount` instead of `price_list_id`. This job lists every customer group and every active price list assignment, flags the groups where both a legacy discount and a price list are configured at once, and clears the legacy `discount_rules` on those groups only, leaving the price list assignment itself untouched.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/legacy-group-discount-blocks-price-list/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python legacy-group-discount-blocks-price-list/python/clear_blocking_group_discounts.py
node   legacy-group-discount-blocks-price-list/node/clear-blocking-group-discounts.js
```

`find_blocked_price_list_groups` (`findBlockedPriceListGroups` in Node) is a pure function that takes only the already-fetched list of customer groups and the already-fetched list of price list assignments, so it is fully testable without a network call. It only flags a group when it has a non-empty `discount_rules` array AND its id appears as `customer_group_id` in at least one price list assignment. Start with `DRY_RUN=true` to review the list first; when `DRY_RUN=false` the script issues the PUT and then re-fetches the group to confirm `discount_rules` is empty.

## Test

```bash
pytest legacy-group-discount-blocks-price-list/python
node --test legacy-group-discount-blocks-price-list/node
```
