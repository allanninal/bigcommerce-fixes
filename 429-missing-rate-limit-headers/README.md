# 429 responses sometimes omit rate limit headers under high load

BigCommerce's REST API normally returns 429 Too Many Requests with four headers, X-Rate-Limit-Time-Window-Ms, X-Rate-Limit-Time-Reset-Ms, X-Rate-Limit-Requests-Quota, and X-Rate-Limit-Requests-Left, so a client can compute exactly how long to back off. When the platform itself is under high load, excessive traffic across a store or a shared infrastructure tier, the edge or proxy layer can throttle a request before it reaches the per-token accounting logic that stamps those headers, so it returns a bare 429 with none of them. Client code that expects the reset header and crashes or retries immediately when it is missing makes the overload worse. This helper checks every 429 for the four headers, uses the exact reset time when present, and falls back to a capped exponential backoff with jitter when it is not, logging the header-less occurrence for monitoring.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/429-missing-rate-limit-headers/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MAX_RETRIES="5"
export DRY_RUN="true"

python 429-missing-rate-limit-headers/python/rate_limit_backoff.py
node   429-missing-rate-limit-headers/node/rate-limit-backoff.js
```

`compute_backoff_seconds` (`computeBackoffSeconds` in Node) is a pure function that takes only a status code, a headers object, and an attempt number, so it is fully testable without a network call. It returns 0 for non-429 responses, the exact `X-Rate-Limit-Time-Reset-Ms` value converted to seconds when that header is present and parseable, and a capped exponential backoff with jitter (base 1s, doubling, cap 60s, +/- 20% jitter) when it is missing, empty, or unparseable. Start with `DRY_RUN=true` to review the flagged header-less 429s first.

## Test

```bash
pytest 429-missing-rate-limit-headers/python
node --test 429-missing-rate-limit-headers/node
```
