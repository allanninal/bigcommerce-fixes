# Customer group mis-assigned

BigCommerce's native storefront only supports one global default customer group at registration. It has no built-in conditional logic to route a signup into a different group by email domain, order history, or a form answer. Merchants get that conditional assignment from a custom script, a webhook, or a third-party app that reads signup or order data and writes `customer_group_id` after the fact, and when that rule has a bug, stale criteria, or races the platform's own default-group assignment, the customer is left in the wrong group and sees the wrong price, since a Price List or discount rule resolves off `customer_group_id`.

This job lists customers with `GET /v3/customers`, computes the expected group for each one from a rule you define with a pure function, diffs it against the actual `customer_group_id`, and reassigns the mismatched ones with a single `PUT /v3/customers`, re-reading the customer to confirm the write persisted. It never touches order history, since BigCommerce does not recompute a past order's price when the group changes.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/customer-group-mis-assigned/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

# Define your own rule
export RULE_MATCH_TYPE="email_domain"        # email_domain | spend_threshold | tax_exempt | source_tag
export RULE_PATTERN="wholesale-buyer.example"
export RULE_THRESHOLD_CENTS="500000"
export RULE_TARGET_GROUP_ID="3"
export RULE_FALLBACK_GROUP_ID="0"

python customer-group-mis-assigned/python/fix_customer_group.py
node   customer-group-mis-assigned/node/fix-customer-group.js
```

`decide_group_reassignment` (Python) and `decideGroupReassignment` (Node) are pure functions that take a customer record and a rule and return `{customerId, currentGroupId, expectedGroupId, needsReassignment, reason}`. They evaluate the rule against the customer's fields only, no network or database calls, so every branch (no match, match, a missing field defaulting to the fallback group, and an already-correct group) is deterministic and testable. The only write is a single-customer `PUT /v3/customers`, always followed by a `GET` to confirm the change persisted. Start with `DRY_RUN=true` to review the diff report before it writes anything.

## Test

```bash
BIGCOMMERCE_STORE_HASH=dummy BIGCOMMERCE_ACCESS_TOKEN=dummy pytest customer-group-mis-assigned/python
node --test customer-group-mis-assigned/node
```
