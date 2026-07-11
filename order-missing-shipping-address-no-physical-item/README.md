# Order missing shipping address when no line item is flagged physical

Flags BigCommerce orders where a physical line item shipped with no
shipping address on file, while correctly leaving all-digital orders
alone. BigCommerce only writes a `shipping_addresses` record when the
cart contained at least one `physical` product, so an empty array from
`GET /v2/orders/{id}/shipping_addresses` is expected behavior for a
digital-only order, not a bug. The real anomaly is a physical item with
no address, most often caused by a custom or headless checkout that
created the order via the API and skipped submitting consignments.

Guide: https://www.allanninal.dev/bigcommerce/order-missing-shipping-address-no-physical-item/

## Run it

Python:

```
cd python
pip install requests
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"   # start safe, change to false to write staff_notes
python flag_missing_shipping_addresses.py
```

Node.js (18+, no dependencies):

```
cd node
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_ACCESS_TOKEN="..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"   # start safe, change to false to write staff_notes
node flag-missing-shipping-addresses.js
```

`DRY_RUN` defaults to `true`. In dry run mode the script only logs the
orders it would flag. The only allowed write action, when `DRY_RUN=false`,
is a low-risk `staff_notes` annotation via `PUT /v2/orders/{id}`. There is
no API to retroactively attach a real shipping address, and inventing one
would corrupt fulfillment and tax data, so this script never does that.

## Test

The pure decision function `classify_shipping_address_gap` /
`classifyShippingAddressGap` takes plain data (status_id, a list of
resolved line item types, and whether a shipping address was found) and
returns a classification string. No network calls, so the tests run
without any BigCommerce credentials.

Python:

```
cd python
pip install pytest
pytest
```

Node.js:

```
cd node
node --test
```
