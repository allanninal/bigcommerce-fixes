# 422 fulfillment address incomplete despite address looking complete

Creating a consignment with `POST /v3/checkouts/{checkoutId}/consignments` only strictly requires the address to carry `email` and `country_code` plus `lineItems`, so that call succeeds even with a partial address. Placing the order with `POST /v3/orders`, or completing checkout, validates a fuller set of subfields: `first_name`, `last_name`, `address1`, `city`, `state_or_province_code`, `postal_code`, `country_code`, and `phone`. The 422 "A fulfillment address for this order is incomplete" only surfaces at that later step, and the missing key, commonly `state_or_province_code`, `postal_code`, or `phone`, or an invalid `country_code`/`country_iso2` pairing, is easy to miss because the address object itself is present. This job lists candidate orders (status_id 0 Incomplete or 11 Awaiting Fulfillment), fetches each stored shipping address, and reports the exact missing or invalid field per order id. It never invents a value; a missing subfield is customer data the script cannot safely guess. Only a narrow, deterministic normalization (a known-good country name to its `country_code`) is ever written, gated by `DRY_RUN`.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/422-fulfillment-address-incomplete/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export ORDER_STATUS_IDS="0,11"
export DRY_RUN="true"

python 422-fulfillment-address-incomplete/python/find_incomplete_fulfillment_addresses.py
node   422-fulfillment-address-incomplete/node/find-incomplete-fulfillment-addresses.js
```

`find_missing_address_fields` (`findMissingAddressFields` in Node) is a pure function that takes only an address object and an optional required-key list, so it is fully testable without a network call. It accepts known aliases (`address1`/`street_1`, `postal_code`/`zip`, `country_code`/`country_iso2`, `state_or_province_code`/`state`), treats empty string, null, or a missing key as failing, and validates `country_code` against a 2-letter alpha pattern. Start with `DRY_RUN=true` to review the flagged list first; the only write it can ever make is a deterministic country-name to `country_code` normalization.

## Test

```bash
pytest 422-fulfillment-address-incomplete/python
node --test 422-fulfillment-address-incomplete/node
```
