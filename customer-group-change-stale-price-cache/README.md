# Customer group change does not immediately refresh cached pricing

BigCommerce resolves customer-group pricing by joining the customer's customer_group_id (a V2-only field, customer groups are "not yet available on the V3 Customers API") to a price list through /v3/pricelists/assignments, then reading /v3/pricelists/{id}/records for the variant. That resolution happens once per cart or session and gets cached: an existing cart keeps the price snapshot captured under the old group, storefront and CDN edge caching can serve pre-rendered pricing for several minutes, and BigCommerce support documentation itself warns pricing changes can take up to about 10 minutes to propagate. So when an admin moves a customer between groups, the customer record updates immediately but an already-created cart, an active browser session, or an edge-cached page keeps quoting the old group's price list until a new cart or session forces re-resolution. This job audits a list of customer/cart pairs, reads each customer's current group and the price list it maps to, compares that against each cart line item's recorded price, and for a genuine mismatch forces that one cart to re-resolve, either by resubmitting the line item quantity or deleting the cart. It never rewrites the price list record itself, since that would change pricing for every customer in the group, not just fix the one stale cart.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/customer-group-change-stale-price-cache/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export CHANNEL_ID="1"
export DRY_RUN="true"
export AUDIT_TARGETS_JSON='[{"customer_id":101,"cart_id":"a1b2c3","old_group_id":3}]'

python customer-group-change-stale-price-cache/python/refresh_stale_group_pricing.py
node   customer-group-change-stale-price-cache/node/refresh-stale-group-pricing.js
```

`is_price_stale` (`isPriceStale` in Node) is a pure function that takes only a cart line item and a price list record, both plain dicts, so it is fully testable without a network call. It compares the price list record's calculated price (its sale_price if set, else its price) against the cart line item's recorded price (its sale_price if set, else its list_price), and returns true only when they disagree by more than a one-cent tolerance. Start with `DRY_RUN=true` to review the list first, and note the price list record itself is never rewritten, only the affected cart is forced to re-resolve.

## Test

```bash
pytest customer-group-change-stale-price-cache/python
node --test customer-group-change-stale-price-cache/node
```
