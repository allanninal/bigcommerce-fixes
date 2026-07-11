# No API endpoint to merge two customer records

BigCommerce creates a fully independent customer record for guest checkout, storefront registration, and admin-panel entry, and treats each customer_id as its own entity with orders owned through order.customer_id and addresses owned through address.customer_id. There is no merge or alias relationship in the data model, and the REST Management API only exposes CRUD on individual resources, never a bulk reassign-all-child-resources call, so BigCommerce never shipped a merge endpoint. This job clusters customers by normalized email, picks a canonical customer_id per cluster, reassigns every order from the duplicate to the canonical id, recreates any address on the canonical id that does not already exist there, and flags the duplicate customer_id for human confirmation. It never deletes a customer record on its own.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/no-customer-merge-endpoint/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python no-customer-merge-endpoint/python/merge_duplicate_customers.py
node   no-customer-merge-endpoint/node/merge-duplicate-customers.js
```

`plan_customer_merge` (`planCustomerMerge` in Node) is a pure function that takes the canonical customer's addresses and the duplicate's orders and addresses, so it is fully testable without a network call. Every order is queued for reassignment regardless of status_id, since refunded and cancelled orders still belong in the shopper's history, and each address is compared by a normalized (address1, postal_code, city) key to decide whether it needs to be recreated on the canonical customer. Start with `DRY_RUN=true` to review the plan first. The script never calls `DELETE` on a customer record; the duplicate customer_id is only ever flagged in the log for a human to confirm.

## Test

```bash
pytest no-customer-merge-endpoint/python
node --test no-customer-merge-endpoint/node
```
