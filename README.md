# bigcommerce-fixes

Small, focused scripts that detect and repair the everyday problems that hit real
[BigCommerce](https://www.bigcommerce.com) stores: orders stuck between statuses,
payments and refunds that do not tie out, oversold or untracked inventory,
webhooks that silently deactivate, duplicate records, and reporting drift.

Every fix ships in **both Python and Node.js**, is **safe by default** (a
`DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has
a **pure decision function** with unit tests, so you can trust the logic before
you point it at a live store.

Each fix has a full write-up with diagrams on
**[allanninal.dev/bigcommerce](https://www.allanninal.dev/bigcommerce/)**.

## How the scripts authenticate

The scripts talk to the BigCommerce **REST Management API**. They read
configuration from the environment:

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"   # set to "false" to actually write
```

Requests go to `https://api.bigcommerce.com/stores/{store_hash}/` with the
headers `X-Auth-Token: <access token>` and `Accept: application/json`. The V3
Management API is under `/v3/...` and the older order endpoints are under
`/v2/...`.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
| [Orders stuck on Awaiting Payment after capture](orders-stuck-on-awaiting-payment-after-capture/) | The gateway took the money but the order sits on Awaiting Payment. Move the paid ones to Awaiting Fulfillment. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/orders-stuck-on-awaiting-payment-after-capture/) |
| [Paid order stuck on Incomplete](paid-order-stuck-on-incomplete/) | A completed payment left the order on Incomplete so it never reaches fulfillment. Find and finish them. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/paid-order-stuck-on-incomplete/) |
| [Manual Verification Required never cleared](manual-verification-required-never-cleared/) | Orders flagged for manual verification sit forever. Surface the ones a human has approved. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/manual-verification-required-never-cleared/) |
| [Declined order still holds stock](declined-order-still-holds-stock/) | A declined order kept its stock reserved. Release the stock so real buyers can order. | Repair | [guide](https://www.allanninal.dev/bigcommerce/declined-order-still-holds-stock/) |
| [Duplicate orders from a double submit](duplicate-orders-from-a-double-submit/) | A double click made two identical orders. Detect the duplicates and cancel the extra. | Repair | [guide](https://www.allanninal.dev/bigcommerce/duplicate-orders-from-a-double-submit/) |
| [Transactions total does not match the order](transactions-total-does-not-match-the-order/) | Captures minus refunds no longer equal the order total. Flag the orders that do not tie out. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/transactions-total-does-not-match-the-order/) |
| [Gateway refund not reflected on the order](gateway-refund-not-reflected-on-the-order/) | A refund in the gateway never updated the order. Record it back so the status is right. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/gateway-refund-not-reflected-on-the-order/) |
| [Disputed order not flagged](disputed-order-not-flagged/) | A chargeback pulled funds but the order shows nothing. Put the dispute state on the order. | Repair | [guide](https://www.allanninal.dev/bigcommerce/disputed-order-not-flagged/) |
| [Webhook deactivated after failures](webhook-deactivated-after-failures/) | BigCommerce disabled your webhook after repeated failures. Detect the gap and recreate it. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/webhook-deactivated-after-failures/) |
| [Duplicate webhook deliveries run twice](duplicate-webhook-deliveries-run-twice/) | The same event arrives more than once and doubles your work. Dedupe on the delivery id. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/duplicate-webhook-deliveries-run-twice/) |
| [Missed webhooks with no backfill](missed-webhooks-with-no-backfill/) | Your app was down past the retry window. Poll updated orders and apply what you missed. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/missed-webhooks-with-no-backfill/) |
| [Webhook payload not verified](webhook-payload-not-verified/) | The webhook body was trusted without verification. Check the signature before acting. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/webhook-payload-not-verified/) |
| [Negative inventory from overselling](negative-inventory-from-overselling/) | Selling past zero pushed stock negative. Reset the oversold variants back to zero. | Repair | [guide](https://www.allanninal.dev/bigcommerce/negative-inventory-from-overselling/) |
| [Available drifts from real on-hand](available-drifts-from-real-on-hand/) | The store count no longer matches the shelf. True it up from a counted source. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/available-drifts-from-real-on-hand/) |
| [Variant inventory not tracked](variant-inventory-not-tracked/) | Tracking was off so a variant never runs out. Detect them and turn tracking on. | Repair | [guide](https://www.allanninal.dev/bigcommerce/variant-inventory-not-tracked/) |
| [Out of stock but still purchasable](out-of-stock-but-still-purchasable/) | Out of stock products can still be bought. Fix the availability so they stop selling. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/out-of-stock-but-still-purchasable/) |
| [Products stranded with no category](products-stranded-with-no-category/) | Products with no category hide from browsing. Assign a fallback category. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/products-stranded-with-no-category/) |
| [Duplicate or missing SKUs](duplicate-or-missing-skus/) | SKUs are duplicated or blank across products. Report the conflicts to fix by hand. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/duplicate-or-missing-skus/) |
| [Broken product images](broken-product-images/) | Product images point to missing files. Detect the broken ones and clear them. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/broken-product-images/) |
| [Price list not applied to a group](price-list-not-applied-to-a-group/) | A customer group is missing its price list prices. Detect and reassign. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/price-list-not-applied-to-a-group/) |
| [Duplicate customers for one email](duplicate-customers-for-one-email/) | The same shopper has several customer records. Merge them so history stays together. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/duplicate-customers-for-one-email/) |
| [Guest orders not linked to accounts](guest-orders-not-linked-to-accounts/) | Guest orders never linked to the customer account. Link them by email. | Repair | [guide](https://www.allanninal.dev/bigcommerce/guest-orders-not-linked-to-accounts/) |
| [Customer group mis-assigned](customer-group-mis-assigned/) | Customers landed in the wrong group so pricing is wrong. Reassign from the rule. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/customer-group-mis-assigned/) |
| [Shipment tracking never added](shipment-tracking-never-added/) | A shipped order has no tracking number. Flag the ones that shipped without it. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/shipment-tracking-never-added/) |
| [Orders stuck Awaiting Shipment past SLA](orders-stuck-awaiting-shipment-past-sla/) | A paid order sat unshipped past your promise. Tag the overdue ones for review. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/orders-stuck-awaiting-shipment-past-sla/) |
| [Partial shipment total mismatch](partial-shipment-total-mismatch/) | A partial shipment left the quantities wrong. Reconcile shipped versus ordered. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/partial-shipment-total-mismatch/) |
| [Coupon usage miscounts](coupon-usage-miscounts/) | The coupon usage count drifted from real use. Recount from the orders. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/coupon-usage-miscounts/) |
| [Expired promotion still applies](expired-promotion-still-applies/) | A promotion past its end date still discounts. Detect and disable it. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/expired-promotion-still-applies/) |
| [Order tax off by a cent](order-tax-off-by-a-cent/) | Tax differs between the storefront and the API. Find the orders that disagree. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/order-tax-off-by-a-cent/) |
| [Presentment vs settlement currency](presentment-vs-settlement-currency/) | The buyer paid one currency and you settled another. Make the exchange explicit. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/presentment-vs-settlement-currency/) |
| [Test orders counted in sales reports](test-orders-counted-in-sales-reports/) | Test orders slipped into real reports. Flag and separate them from live sales. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/test-orders-counted-in-sales-reports/) |
| [Stale product modifiers after import](stale-product-modifiers-after-import/) | An import left broken product modifiers. Detect the ones that no longer apply. | Diagnostic | [guide](https://www.allanninal.dev/bigcommerce/stale-product-modifiers-after-import/) |
| [Abandoned cart records pile up](abandoned-cart-records-pile-up/) | Old abandoned carts clutter the store. Report the stale ones for cleanup. | Reconciler | [guide](https://www.allanninal.dev/bigcommerce/abandoned-cart-records-pile-up/) |
| [Backfill order metadata for matching](backfill-order-metadata-for-matching/) | Old orders lack the external id needed to reconcile. Backfill it safely. | Repair | [guide](https://www.allanninal.dev/bigcommerce/backfill-order-metadata-for-matching/) |
