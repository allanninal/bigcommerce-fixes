# Rate limit callback fires only once per session instead of per request

BigCommerce enforces a sliding request quota per store (default 150 requests per 30,000 ms window for OAuth apps) and reports the live state on every response through `X-Rate-Limit-Requests-Left`, `X-Rate-Limit-Requests-Quota`, `X-Rate-Limit-Time-Window-Ms`, and `X-Rate-Limit-Time-Reset-Ms`. There is no server-side webhook or push callback for rate limiting, it is purely response header driven. Client libraries such as bigcommerce-api-python wire a callback function into the client once, at construction time, and their internal "requests remaining" counter is only updated inside their own request loop rather than re-read from the live headers on every call, so the callback fires a single time instead of on every request that crosses the threshold. The script then free runs on stale internal state and keeps colliding with the real quota, hitting repeated 429 Too Many Requests responses. This helper reads the four rate limit headers off every response and decides, fresh each time, whether to sleep before the next call, never trusting a one-shot callback.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/rate-limit-callback-fires-once/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MIN_REQUESTS_REMAINING="10"
export DRY_RUN="true"

python rate-limit-callback-fires-once/python/rate_limit_guard.py
node   rate-limit-callback-fires-once/node/rate-limit-guard.js
```

`should_throttle` (`shouldThrottle` in Node) is a pure function that takes only requests left, the reset window in milliseconds, a minimum threshold, and the status code, so it is fully testable without a network call. It returns `(True, time_reset_ms)` whenever `status_code == 429` or `requests_left` is missing or at or below the threshold, meaning the caller must sleep `time_reset_ms` before its next request. Missing or invalid header values fail safe toward throttling. Start with `DRY_RUN=true` to replay the throttle decisions against a historical log before making any live calls.

## Test

```bash
pytest rate-limit-callback-fires-once/python
node --test rate-limit-callback-fires-once/node
```
