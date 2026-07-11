# Customer address create no-ops on an exact duplicate with a 200 response

BigCommerce's V3 Customer Addresses endpoint treats first_name, last_name, company, phone, address_type, address1, address2, city, country_code, state_or_province, and postal_code as a uniqueness key per customer. When a POST to /v3/customers/addresses matches an existing address on all of these fields, BigCommerce makes no change to the existing record and returns a 200 or 207 success, but the address is omitted from the response body's data, so no new address id is ever returned. An integration that assumes 200 means "created, id returned" will misreport the operation and drift out of sync with the store's real address list. This script snapshots a customer's addresses before the write, posts the new address, snapshots again, and classifies the result as created, silent_noop, or error with a pure function. A confirmed silent no-op is flagged and reported with the matched existing address id, never retried, since there is no bad state to repair.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/duplicate-address-create-silent-noop/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python duplicate-address-create-silent-noop/python/detect_address_noop.py
node   duplicate-address-create-silent-noop/node/detect-address-noop.js
```

`classify_address_create_result` (`classifyAddressCreateResult` in Node) is a pure function that takes only a pre-write snapshot, the POST response, and a post-write snapshot, so it is fully testable without a network call. It returns `error` on a 4xx/5xx status, `silent_noop` when the response has no address id and the address count and id set are unchanged from before the write, and `created` otherwise. Start with `DRY_RUN=true` to review the pre-write snapshot first; the script makes no write while it is true.

## Test

```bash
pytest duplicate-address-create-silent-noop/python
node --test duplicate-address-create-silent-noop/node
```
