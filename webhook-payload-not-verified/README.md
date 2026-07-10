# Webhook payload not verified

BigCommerce webhook callbacks carry a `hash` field, but BigCommerce has never published a supported formula for validating it, so its presence is not real verification. The documented safeguard is the optional `headers` object you set when creating a hook with `POST /v3/hooks`, which BigCommerce echoes back on every callback as a shared secret. This job scans hooks for a missing secret, provisions one when confirmed missing, and provides a pure classification function a receiver can use before ever acting on the payload.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/webhook-payload-not-verified/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export WEBHOOK_SECRET_HEADER_NAME="X-Webhook-Secret"
export DRY_RUN="true"

python webhook-payload-not-verified/python/verify_webhook_secret.py
node   webhook-payload-not-verified/node/verify-webhook-secret.js
```

`classify_webhook_request` / `classifyWebhookRequest` is a pure function that decides `UNVERIFIABLE_NO_SECRET`, `REJECT_MISMATCH`, `REJECT_USED_BEFORE_CHECK`, or `TRUSTED` from the hook's configured `headers` and the incoming request, with no network calls. Wire it into your receiver so the constant-time header comparison runs before any order or inventory mutation, such as `PUT /v2/orders/{id}` or a V3 inventory adjustment. The scan script only provisions a secret onto a hook that is confirmed missing one, and never overwrites an existing secret. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest webhook-payload-not-verified/python
node --test webhook-payload-not-verified/node
```
