# Order tax off by a cent

BigCommerce's tax engine, manual or automatic, calculates sales tax per line item, unit price times rate, rounding a half cent or above up to the nearest cent, then sums those independently rounded line amounts into `order.total_tax`. The storefront cart or checkout can show a subtotal-level estimate or an async tax provider figure, so what the customer saw and what BigCommerce persisted can differ by a cent or more, especially on multi-quantity lines or orders spanning multiple tax classes. This job reads each order's `total_tax` alongside the authoritative `GET /v2/orders/{id}/taxes` breakdown and the `GET /v2/orders/{id}/products` line detail, sums both independently, and writes a `TAX_MISMATCH` note to `staff_notes` when they disagree by a cent or more. It never edits `total_tax` or a line's `price_tax`, because a rounding difference is not automatically a wrong charge, and a blind write risks masking a real accounting error.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/order-tax-off-by-a-cent/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TAX_EPSILON_CENTS="1"
export DRY_RUN="true"

python order-tax-off-by-a-cent/python/find_tax_mismatch.py
node   order-tax-off-by-a-cent/node/find-tax-mismatch.js
```

`find_tax_mismatch` / `findTaxMismatch` is a pure function that works in integer cents, so the comparison never suffers decimal-string rounding drift and is fully testable. It compares `order.total_tax` against both the `/taxes` endpoint sum and the `/products` `price_tax` sum, and reports whichever source disagrees by the larger magnitude. The only write is a `staff_notes` flag, so it never moves money or edits a tax total. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-tax-off-by-a-cent/python
node --test order-tax-off-by-a-cent/node
```
