# bigcommerce-fixes

Small, focused scripts that detect and repair the everyday problems that hit real
[BigCommerce](https://www.bigcommerce.com) stores: orders stuck between statuses,
payments and refunds that do not tie out, oversold or untracked inventory,
webhooks that silently deactivate, duplicate records, and reporting drift.

Every fix ships in **both Python and Node.js**, is **safe by default** (a
`DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has
a **pure decision function** with unit tests, so you can trust the logic before
you point it at a live store.

Each fix has a full write-up with diagrams on
**[allanninal.dev/bigcommerce](https://www.allanninal.dev/bigcommerce/)**.

## How the scripts authenticate

The scripts talk to the BigCommerce **REST Management API**. They read
configuration from the environment:

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"   # set to "false" to actually write
```

Requests go to `https://api.bigcommerce.com/stores/{store_hash}/` with the
headers `X-Auth-Token: <access token>` and `Accept: application/json`. The V3
Management API is under `/v3/...` and the older order endpoints are under
`/v2/...`.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
