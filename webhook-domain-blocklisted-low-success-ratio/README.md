# Webhook domain blocklisted after low delivery success ratio

BigCommerce's webhook dispatcher tracks a rolling success versus failure ratio per destination domain over a sliding 2-minute window, evaluated only once at least 100 requests have landed in that window. If the ratio drops below 90 percent, typically because the receiving endpoint is slow, returning non-200s, or intermittently down, BigCommerce blocklists the entire domain for 3 minutes, not just the failing hook. Because the block is domain scoped, one flaky path (for example `/webhooks/orders`) can starve delivery to an unrelated healthy hook (for example `/webhooks/inventory`) on the same host. If the instability persists, the same webhook can also hit the separate 48-hour / 11-retry exhaustion path and get permanently deactivated (`is_active=false`).

There is no safe API call to lift a domain blocklist or force a redelivery, it self-expires and BigCommerce requeues automatically. This script lists registered hooks with `GET /v3/hooks`, correlates them against your own app's request log to compute rolling success ratios per domain, reports any domain at risk and any hook already deactivated, and makes exactly one kind of write: re-enabling a hook with `PUT /v3/hooks/{hook_id}` and `{"is_active": true}`, and only after a synthetic health-check request to the destination returns 200.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/webhook-domain-blocklisted-low-success-ratio/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export MIN_SAMPLE="100"
export SUCCESS_THRESHOLD="0.90"
export DRY_RUN="true"

python webhook-domain-blocklisted-low-success-ratio/python/webhook_domain_health.py
node   webhook-domain-blocklisted-low-success-ratio/node/webhook-domain-health.js
```

`evaluate_webhook_health` (`evaluateWebhookHealth` in Node) is a pure function that takes only a list of `{timestamp, domain, status_code}` entries for a single rolling 2-minute window, so it is fully testable without a network call. It returns `success_ratio: None` (and `at_risk: False`) until a domain has seen at least `min_sample` requests, matching BigCommerce's own rule, and only marks a domain `at_risk` once its ratio drops below `threshold`. Start with `DRY_RUN=true` to review the report first; the only actual write the script makes is re-enabling a hook BigCommerce already deactivated, and only after a live health check on its destination passes.

## Test

```bash
pytest webhook-domain-blocklisted-low-success-ratio/python
node --test webhook-domain-blocklisted-low-success-ratio/node
```
