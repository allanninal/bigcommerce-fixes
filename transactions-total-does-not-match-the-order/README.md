# Transactions total does not match the order

Order totals (`total_inc_tax`, `refunded_amount`) and the gateway transaction ledger are written through separate BigCommerce code paths. A refund issued directly in the gateway's own dashboard, a partial or store-credit refund never posted back as a transaction, or an overridden refund_quote amount can leave the two records disagreeing. This job reads each recent order's total and refunded amount, sums its settled purchase, capture, and refund transactions, and writes a `RECON_MISMATCH` note to `staff_notes` when the two disagree by more than a cent. It never edits `total_inc_tax`, `refunded_amount`, or `status_id`, because the mismatch can originate on either side and a blind write risks masking a real accounting error or double-crediting a customer.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/transactions-total-does-not-match-the-order/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export RECON_EPSILON_CENTS="1"
export DRY_RUN="true"

python transactions-total-does-not-match-the-order/python/find_transactions_mismatch.py
node   transactions-total-does-not-match-the-order/node/find-transactions-mismatch.js
```

`reconcile_order_transactions` / `reconcileOrderTransactions` is a pure function that works in integer cents, so the comparison never suffers decimal-string rounding drift and is fully testable. The only write is a `staff_notes` flag, so it never moves money or edits a total. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest transactions-total-does-not-match-the-order/python
node --test transactions-total-does-not-match-the-order/node
```
