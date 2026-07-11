# Promotion with both group_ids and excluded_group_ids never triggers

BigCommerce's Promotions API accepts a customer eligibility object with both `group_ids` (an allow-list of customer group IDs) and `excluded_group_ids` (a deny-list) populated at the same time, even though BigCommerce's own docs say only one of the two fields should be used at a time. The write succeeds with no validation error, but the promotion engine's eligibility check has no defined precedence between the allow-list and the deny-list, so it fails closed and the promotion silently never triggers at checkout for any shopper, even ones who satisfy `group_ids`. This job lists every `ENABLED` promotion, flags the ones with a conflicting allow-list and deny-list at the top level or inside any rule, and only ever reports the conflict with a suggested fix, unless explicitly told to apply the opt-in `--apply-clear-excluded` remediation.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/promotion-group-exclusion-conflict/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python promotion-group-exclusion-conflict/python/find_group_conflicts.py
node   promotion-group-exclusion-conflict/node/find-group-conflicts.js

# Opt in to clearing excluded_group_ids on flagged top-level conflicts
DRY_RUN=false python promotion-group-exclusion-conflict/python/find_group_conflicts.py --apply-clear-excluded
DRY_RUN=false node   promotion-group-exclusion-conflict/node/find-group-conflicts.js --apply-clear-excluded
```

`decide_group_conflict` (`decideGroupConflict` in Node) is a pure function that takes only `group_ids` and `excluded_group_ids` and returns a plain conflict verdict, so it is fully testable without a network call. It flags a conflict only when both lists are non-empty (including the group id `0` guest sentinel appearing in either list), and suggests clearing `excluded_group_ids` by default because that keeps the narrower, more deliberate allow-list. Start with `DRY_RUN=true` to review the flagged list first; nothing is ever mutated automatically.

## Test

```bash
pytest promotion-group-exclusion-conflict/python
node --test promotion-group-exclusion-conflict/node
```
