# Order total wrong when only one of price_ex_tax or price_inc_tax is set

BigCommerce's V2 Orders API (POST/PUT /v2/orders) lets integrators override computed money fields, but each override is defined in tax-inclusive/exclusive pairs: a line item's price_inc_tax requires price_ex_tax (and vice versa), and an order's total_inc_tax requires total_ex_tax (and vice versa). If a client sets only one side of a pair, BigCommerce does not reject the request or auto-derive the missing value from store tax rules. It stores exactly what it was given, so the untouched field keeps its stale or default value, often 0.00. This job pages through orders in a date range, reads each order's totals and line items, and reports every order where one side of a pair is partially set or where the line-item sum does not reconcile against the order total within a cent. A guarded, opt-in repair path exists for orders explicitly confirmed as not yet invoiced or shipped.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-total-partial-tax-field-override/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MIN_DATE_CREATED="-30 days"
export DRY_RUN="true"
export CONFIRMED_ORDER_IDS=""   # comma-separated order ids explicitly authorized for repair

python order-total-partial-tax-field-override/python/find_tax_override_desync.py
node   order-total-partial-tax-field-override/node/find-tax-override-desync.js
```

`find_tax_override_desync` (`findTaxOverrideDesync` in Node) is a pure function that takes only an already-fetched order and its line items and returns a list of findings, so it is fully testable without a network call. It flags a `partial_override` when one side of an ex_tax/inc_tax pair is zero or missing while the other is not, and a `total_mismatch` when the line items plus shipping and handling minus discount do not sum to the order's total_inc_tax within a small epsilon. By default the job only reports. A write only ever happens for an order id present in `CONFIRMED_ORDER_IDS`, still at status_id 0 (Incomplete) or 11 (Awaiting Fulfillment), and only when `DRY_RUN=false`.

## Test

```bash
pytest order-total-partial-tax-field-override/python
node --test order-total-partial-tax-field-override/node
```
