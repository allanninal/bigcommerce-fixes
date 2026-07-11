# Order-level refund does not recalculate total_tax

BigCommerce refunds come in two flavors: line-item refunds, which reference a specific product line and route through the store's tax provider to recompute tax on the refunded quantity, and order-level or custom-amount refunds, sent with item_type "ORDER". An order-level refund is treated as a flat, tax-exempt custom amount against the total refundable order amount, so the Create Refund Quote step returns total_refund_tax_amount = 0 and the refund is processed without touching tax. The order's stored total_tax (and downstream total_inc_tax/total_ex_tax) is never decremented for the tax portion of what was actually refunded. This job lists Refunded and Partially Refunded orders, reconciles each order's stored total_tax against its refund transactions, and reports every mismatch, never writing directly to total_tax since BigCommerce exposes no supported endpoint for that.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-refund-does-not-recalc-tax/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MIN_DATE_MODIFIED="-30 days"
export DRY_RUN="true"

python order-refund-does-not-recalc-tax/python/reconcile_refund_tax.py
node   order-refund-does-not-recalc-tax/node/reconcile-refund-tax.js
```

`reconcile_order_tax` (`reconcileOrderTax` in Node) is a pure function that takes only an order dict and its refund transactions, so it is fully testable without a network call. It flags an order either when the recomputed expected total_tax disagrees with the stored total_tax by more than a cent, or when any order-level (`item_type: "ORDER"`) refund transaction recorded a positive amount with zero tax, which is the exact signature of this bug. Start with `DRY_RUN=true` to review the reconciliation report first. Only under an explicit `DRY_RUN=false` does the script optionally re-issue a corrective line-item refund for the shortfall, and only for an order that still has refundable balance.

## Test

```bash
pytest order-refund-does-not-recalc-tax/python
node --test order-refund-does-not-recalc-tax/node
```
