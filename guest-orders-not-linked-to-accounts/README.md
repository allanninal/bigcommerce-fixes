# Guest orders not linked to accounts

BigCommerce checkout lets shoppers buy without registering, and every guest order is stored with customer_id = 0 permanently. BigCommerce never retroactively links it, even if that same email later registers or already has an account. Matching is name and email based only in the merchant's head, since the storefront and Order Management UI have no automatic "same email, different order" reconciliation. At scale this means loyalty history, reorder, and lifetime value reporting silently miss every guest purchase whose email happens to match a real account. This job lists guest orders (customer_id = 0), resolves each order's billing email against the customer table, and reassigns customer_id only when there is exactly one confident match. Ambiguous or unmatched orders are flagged for manual review instead of a blind write.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/guest-orders-not-linked-to-accounts/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python guest-orders-not-linked-to-accounts/python/link_guest_orders.py
node   guest-orders-not-linked-to-accounts/node/link-guest-orders.js
```

`decide_order_link` (`decideOrderLink` in Node) is a pure function that takes only an order and its pre-fetched customer matches, so it is fully testable without a network call. It returns `link` only when the order is still a guest order (customer_id = 0), the status is not Incomplete, Cancelled, or Declined, and exactly one customer record matches the billing email (case and whitespace insensitive). It returns `flag` when zero or multiple customers share that email, so those stay in the admin's "Existing customer" order-edit flow for a human to confirm. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest guest-orders-not-linked-to-accounts/python
node --test guest-orders-not-linked-to-accounts/node
```
