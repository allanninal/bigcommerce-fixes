# Concurrent price list bulk upserts fail the whole batch with 429

BigCommerce serializes writes to Price List records at the store level. The bulk upsert endpoint, `PUT /v3/pricelists/{price_list_id}/records`, allows only one in-flight bulk upsert job per store at a time, regardless of which price list is targeted. When multiple jobs, cron tasks, or app instances submit bulk PUT batches concurrently, for example a nightly sync fanning out one job per price list, the platform's price-list processing lock rejects every overlapping request with HTTP 429. Unlike a partial-batch validation error, the entire batch is dropped rather than partially applied, so none of the up to 1000 records in that call are upserted. This fix acquires a per-store lock before every bulk PUT, queues competing jobs instead of racing them, and on a 429 backs off with jitter and resubmits the identical batch, which is safe because the endpoint upserts on variant_id or sku plus price_list_id and currency.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/concurrent-price-list-upserts-429/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MAX_ATTEMPTS="6"
export DRY_RUN="true"

python concurrent-price-list-upserts-429/python/serialize_price_list_upserts.py
node   concurrent-price-list-upserts-429/node/serialize-price-list-upserts.js
```

`decide_retry` (`decideRetry` in Node) is a pure function that takes only a status code, an attempt count, and the response headers, so it is fully testable without a network call. It returns `success` on 200/201/207, `retry` with a computed `wait_ms` on 429 or 5xx (honoring `X-Rate-Limit-Time-Reset-Ms` or `Retry-After` when present, otherwise capped exponential backoff), and `give_up` once attempts are exhausted or the status is a non-429 4xx. Start with `DRY_RUN=true` to see the planned serialized submission order and lock/queue wait time per job before any real lock is acquired or any PUT is issued.

## Test

```bash
pytest concurrent-price-list-upserts-429/python
node --test concurrent-price-list-upserts-429/node
```
