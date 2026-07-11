# Order created via API bypasses customer group and price list pricing

BigCommerce's V2 Create Order endpoint, `POST /v2/orders`, is a back-office order-entry API, not the storefront checkout pricing engine. It only runs a cart through the pricing service if the caller omits price fields entirely. When an integration supplies `price_inc_tax`/`price_ex_tax` on each line item, exactly what "pre-resolving" pricing client-side produces, BigCommerce takes that number as authoritative and skips resolution against the customer's assigned Price List or catalog customer-group discount rules entirely. Because the order has no `cart_id` tying it back to a priced cart, there is no signal the submitted price might be stale, wrong, or unresolved. This job scans recent orders, resolves each customer's assigned price list, and flags any line billed at plain catalog price (or any other mismatched price) when the price list disagrees. It never rewrites a placed order's price fields; it only cancels an unpaid order with no captured transaction, or reports a delta for a human to refund or credit.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/api-order-bypasses-group-pricing/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export CHANNEL_ID="1"
export DRY_RUN="true"

python api-order-bypasses-group-pricing/python/diagnose_order_pricing.py
node   api-order-bypasses-group-pricing/node/diagnose-order-pricing.js
```

`diagnose_order_line_pricing` (`diagnoseOrderLinePricing` in Node) is a pure function that takes only a customer group id, an assigned price list id, a price-list record price, a catalog price, the billed price, the order's `status_id`, and whether a transaction has already been captured, all as plain values, so it is fully testable without a network call. It only recommends `cancel_unpaid` when the order is in the API-creation status window (0, 7, 11) with no captured transaction; every other flagged line recommends `report_refund_delta` for a human to issue a manual refund or store credit. Start with `DRY_RUN=true` to review the report first; this script never rewrites price fields on a placed order.

## Test

```bash
pytest api-order-bypasses-group-pricing/python
node --test api-order-bypasses-group-pricing/node
```
