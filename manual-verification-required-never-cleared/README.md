# Manual Verification Required never cleared

Orders land on `status_id 12` (Manual Verification Required) when a fraud-screening app (FraudLabs Pro, NoFraud, Signifyd, Kount) or an ERP connector (such as Acumatica) writes back a REVIEW verdict through the Orders API. The human review then happens inside that app's own dashboard, not in BigCommerce, so there is no built-in trigger that clears the order once a person approves it there. This job lists orders on status_id 12, decides `clear`, `hold`, or `skip` with a pure function that looks for an explicit human-approval marker in `staff_notes` or order messages plus a non-declined transaction, and only moves a confirmed batch to `status_id 11` (Awaiting Fulfillment) one order at a time, leaving an audit message behind.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/manual-verification-required-never-cleared/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export MIN_DATE_MODIFIED=""   # optional, for incremental runs
export DRY_RUN="true"

python manual-verification-required-never-cleared/python/clear_manual_verification.py
node   manual-verification-required-never-cleared/node/clear-manual-verification.js
```

`decide_clearable` (Python) and `decideClearable` (Node) are pure functions with no I/O, so the branching between review-still-pending, human-approved, and payment-problem is fully testable against fixture data. The script never auto-transitions an order based on elapsed time alone. It only reports candidates, and only writes when `DRY_RUN=false` and a human has confirmed the batch. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest manual-verification-required-never-cleared/python
node --test manual-verification-required-never-cleared/node
```
