# Presentment vs settlement currency

A shopper checks out in one currency, the store's books run in another, and the
gateway settles to the bank in a rate and timing of its own. On a BigCommerce
store with Multi-Currency enabled, an order's `default_currency_code` (what the
shopper paid) can differ from `store_default_currency_code` (the store's base
currency), and the two are tied together by
`store_default_to_transactional_exchange_rate`. This job reads each financially
final order's currency fields, computes the expected base-currency amount as
`total_inc_tax * store_default_to_transactional_exchange_rate`, compares it
against your ledger's recorded amount for that order, and writes an
`FX_VARIANCE` note to `staff_notes` when they disagree by more than a
tolerance. It never edits `total_inc_tax`, `default_currency_code`, or the
exchange rate.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/presentment-vs-settlement-currency/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export FX_TOLERANCE_RATIO="0.005"
export DRY_RUN="true"

python presentment-vs-settlement-currency/python/find_currency_variance.py
node   presentment-vs-settlement-currency/node/find-currency-variance.js
```

`classify_currency_variance` is a pure function that takes an order's currency
fields and a ledger amount and returns whether they tie out within a
ratio-based tolerance, so the comparison scales correctly for both small and
large orders and is fully testable without a network call. The only write is a
`staff_notes` annotation, so it never moves money or edits the order's totals.
Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest presentment-vs-settlement-currency/python
node --test presentment-vs-settlement-currency/node
```
