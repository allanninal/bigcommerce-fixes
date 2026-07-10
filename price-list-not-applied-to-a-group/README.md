# Price list not applied to a group

A BigCommerce Price List is only a container of custom prices. It has no effect on a customer group until a Price List Assignment row links `price_list_id` and `customer_group_id`, and optionally `channel_id`, through the V3 Price Lists Assignments API. Building prices through a CSV import, migrating off the legacy v2 group discount model, or adding a new sales channel commonly leaves that row missing or scoped to the wrong channel, and the group silently falls back to default catalog pricing with no error surfaced anywhere.

This job checks every customer group that has active customers, resolves the price list, and decides with a pure function whether to create a missing assignment, fix one scoped to a channel the group's customers do not use, or flag the price list when it is correctly assigned but missing records for the variants being bought.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/price-list-not-applied-to-a-group/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export DRY_RUN="true"

python price-list-not-applied-to-a-group/python/fix_price_list_assignment.py
node   price-list-not-applied-to-a-group/node/fix-price-list-assignment.js
```

`decide_reassignment` (Python) and `decideReassignment` (Node) are pure functions with no I/O, so the whole decision tree is fully testable. Creating or fixing an assignment is additive and reversible. A price list with missing records for a variant is never auto-repaired, it is only flagged for a merchandiser. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest price-list-not-applied-to-a-group/python
node --test price-list-not-applied-to-a-group/node
```
