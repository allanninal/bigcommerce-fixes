# Refunded line items are not returned to inventory automatically

BigCommerce's refund flow, `POST /v3/orders/{order_id}/payment_actions/refunds` and the legacy `/v2/orders/{id}/transactions` path, is scoped purely to reversing the payment with the gateway. It records which line items and quantities were refunded but never touches the catalog or inventory subsystem. Stock levels (`inventory_level`, `inventory_warning_level`) live on `/v3/catalog/products` and its variants and only change from order creation or cancellation triggers, direct catalog PUTs, or the dedicated `/v3/inventory/adjustments` endpoints. Because refunds are commonly partial, issued out of band, and do not always mean the item is restockable (damaged, lost in transit, goodwill refund), BigCommerce leaves the restock decision to the merchant, so refunded quantity and on-hand stock silently drift apart unless something reconciles them.

This job lists orders at status_id 4 (Refunded) or 14 (Partially Refunded), reads each order's refunds, resolves them to `product_id`/`variant_id` and quantity, and restocks only the lines that are not already reconciled and not flagged as damaged, lost, or return-not-received via a compensating `PUT /v3/inventory/adjustments/relative`.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/refund-does-not-restock-inventory/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="30"
export LEDGER_PATH="reconciled_refunds.json"
export DRY_RUN="true"

python refund-does-not-restock-inventory/python/restock_refunded_inventory.py
node   refund-does-not-restock-inventory/node/restock-refunded-inventory.js
```

`compute_restock_adjustments` (`computeRestockAdjustments` in Node) is a pure function that takes only a list of resolved refund lines, a set of already-reconciled `refund_item_id`s, and a map of skip flags, so it is fully testable without a network call. It returns one compensating adjustment per line that is unreconciled and not flagged, with `adjustment` always a positive quantity. Start with `DRY_RUN=true` to review the list first, and never let it auto-restock a line whose order carries a damaged, lost, or return-not-received note.

## Test

```bash
pytest refund-does-not-restock-inventory/python
node --test refund-does-not-restock-inventory/node
```
