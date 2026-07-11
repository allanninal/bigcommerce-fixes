# Order count endpoint disagrees with actual paginated order list

BigCommerce's `GET /v2/orders/count` and a full paginated scan of `GET /v2/orders`
can report two different totals. Both endpoints accept the same `status_id`,
`min_date_created`, `max_date_created`, and `customer_id` filters, and both apply
an implicit default scope when `status_id` is omitted. Incomplete orders
(`status_id` 0, abandoned at payment) are commonly excluded from an unfiltered
count's default scope but still appear in an unfiltered pagination scan, so a
script calling one endpoint with no filters and the other with a different
filter set ends up comparing two different result sets. A secondary cause is
timing: count is a point-in-time snapshot, while a multi-page scan can take
seconds to minutes on a large store.

This reconciler sums per-status counts across all 15 `status_id` values, fully
paginates the order list with the same filters, reconciles the two totals
bucket by bucket, and re-checks the count snapshot after pagination to rule
out concurrency drift. It only ever reports. It never deletes or modifies an
order based on a count mismatch alone.

Guide: https://www.allanninal.dev/bigcommerce/order-count-endpoint-mismatch/

## Run it

### Python

```
cd python
pip install requests
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="..."
export MIN_DATE_CREATED=""   # optional, e.g. "2026-01-01"
export DRY_RUN="true"        # this reconciler only ever reports, never writes
python reconcile_order_counts.py
```

### Node.js

```
cd node
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="..."
export MIN_DATE_CREATED=""   # optional, e.g. "2026-01-01"
export DRY_RUN="true"        # this reconciler only ever reports, never writes
node reconcile-order-counts.js
```

## Test

The pure `reconcile_order_counts` / `reconcileOrderCounts` function needs no
network and no BigCommerce store. Tests feed in synthetic count maps and
status_id lists and check the returned report.

### Python

```
cd python
pip install pytest
pytest -v
```

### Node.js

```
cd node
node --test
```
