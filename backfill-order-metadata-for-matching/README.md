# Backfill order metadata for matching

Orders placed before an ERP, marketplace, or order-management integration was wired up were created without `external_id`, `external_merchant_id`, or `external_source`, because those fields are only populated by whichever client submits the order at creation time. BigCommerce treats `external_merchant_id` as write-once, a `PUT` that tries to change it after it is first set returns a 400, and `external_id` behaves the same way once the order already exists. That leaves a population of legacy orders with no durable cross-system key, so later reconciliation jobs can only join on fuzzy fields like customer email, total, and date, which is unreliable at scale.

This job scans the pre-migration date window with `GET /v2/orders`, inspects each order's full payload with `GET /v2/orders/{id}`, and flags any order whose `external_id`, `external_merchant_id`, and `external_source` are all missing or unrecognized. Instead of fighting the write-once fields, it matches each flagged order against an external export and writes an idempotent reconciliation tag into `staff_notes`, a control-panel-only field that stays mutable for the life of the order, for example `[RECON:ext_id=ERP-00219482;source=M-MIG;matched=2026-07-10]`. Orders below the confidence threshold get `[RECON:UNMATCHED]` instead of a guess, and incomplete or voided orders (`status_id` 0, 5, 6) are always skipped.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/backfill-order-metadata-for-matching/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="..."
export MIGRATION_CUTOFF="2025-01-01T00:00:00+00:00"
export CUTOVER_DATE="2025-06-01T00:00:00+00:00"
export MATCH_CONFIDENCE_THRESHOLD="0.8"
export DRY_RUN="true"

python backfill-order-metadata-for-matching/python/backfill_order_metadata.py
node   backfill-order-metadata-for-matching/node/backfill-order-metadata.js
```

`decide_backfill_action` / `decideBackfillAction` is a pure function that takes an order, a candidate match (or `None`/`null`), and the current timestamp, and returns the action to take, no network calls, so it is fully unit-testable with plain fixtures. The only write is `staff_notes`, and it is re-checked with a fresh `GET` right before writing so the job never double-tags an order. Start with `DRY_RUN=true` to review the list first, and only flip it off once you agree with the matches. `external_id` and `external_merchant_id` are never rewritten.

## Test

```bash
pytest backfill-order-metadata-for-matching/python
node --test backfill-order-metadata-for-matching/node
```
