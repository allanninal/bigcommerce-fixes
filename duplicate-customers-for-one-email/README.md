# Duplicate customers for one email

BigCommerce enforces email uniqueness only within the customer record created through a single path at a time: guest checkout (which stores the email on `order.billing_address` and leaves `order.customer_id` at 0, meaning no customer record exists), storefront self-registration, admin-panel manual creation, and V3 Customers API upserts. Nothing reconciles a guest order to a later account, and nothing merges two customer objects that share an email. This job pulls every customer and every orphaned guest order, groups them by normalized email, picks a survivor per cluster, reassigns every matching order onto it, and only deletes the duplicate once its orders are confirmed moved.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/duplicate-customers-for-one-email/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python duplicate-customers-for-one-email/python/merge_duplicate_customers.py
node   duplicate-customers-for-one-email/node/merge-duplicate-customers.js
```

`plan_customer_merge` is a pure function that groups customers by normalized (trimmed, lowercased) email, picks the customer with the earliest `date_created` (tie-break: lowest id) as the survivor, and finds every order that should be reassigned onto that survivor, including guest orders sitting at `customer_id = 0`. It never fuzzy-matches names. The script only deletes a duplicate customer after re-confirming its orders are gone, and every write, reassignment or delete, is gated behind `DRY_RUN`. Start with `DRY_RUN=true` to review the merge plan first.

## Test

```bash
pytest duplicate-customers-for-one-email/python
node --test duplicate-customers-for-one-email/node
```
