# Customer password update intermittently returns random 400 errors

PUT /v3/customers is a batch array endpoint, capped at 3 concurrent requests, that validates each customer object's authentication.new_password against the store's password complexity and history rules server side without exposing those rules through the same response. A 400 for one array element can mean the password genuinely failed a hidden rule, or it can mean the request collided with the concurrency ceiling, or it can be a stale error on a retry after the password was already written. The HTTP status code alone cannot tell these apart, because the response body carries the authoritative per item outcome, and the customer's own date_modified timestamp (or a validate-credentials check) is closer to ground truth than any status code. This script never auto-resubmits a raw password on a bare 400. It re-checks every customer whose PUT returned non-2xx, and only queues a corrective retry for a confirmed still-failed write in a transient status class. A persistent complexity or history failure is reported to a human, not retried.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/customer-password-update-random-400/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MAX_RETRIES="3"
export DRY_RUN="true"

python customer-password-update-random-400/python/recheck_password_updates.py
node   customer-password-update-random-400/node/recheck-password-updates.js
```

`decide_password_update_outcome` (`decidePasswordUpdateOutcome` in Node) is a pure function that takes only a pre and post `date_modified` value, an HTTP status, a response body, and a customer id, so it is fully testable without a network call. It returns `confirmed_success` whenever `date_modified` actually advanced, regardless of the HTTP status, `needs_retry` only for a transient status class (429, a 500-range error, or a per-item error naming a rate or concurrency problem) within the retry ceiling, and `needs_human_review` otherwise. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest customer-password-update-random-400/python
node --test customer-password-update-random-400/node
```
