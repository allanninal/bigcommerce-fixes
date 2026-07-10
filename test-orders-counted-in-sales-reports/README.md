# Test orders counted in sales reports

BigCommerce order objects, in both `/v2/orders` and V3, have no `is_test` flag. Every store ships with a Test Payment Gateway enabled by default so staff can validate tax, shipping, and promotion configuration by placing real checkouts, and merchants often leave real gateways in sandbox mode during setup too. Those checkouts create fully formed orders with normal, revenue-counted `status_id` values, and Store Overview and Sales reports simply aggregate by `status_id`, so the test order counts as revenue until someone notices the numbers do not match the bank.

This job lists revenue-counted orders in a reporting window, pulls each order's transactions, and classifies it with a pure function against four signals: a test transaction flag, a Test Payment Gateway name, a test-looking billing email, and a nominal guest checkout total. Anything that classifies as a test order gets a non-destructive marker appended to the internal `staff_notes` field. Nothing is ever cancelled or deleted automatically.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/test-orders-counted-in-sales-reports/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python test-orders-counted-in-sales-reports/python/flag_test_orders.py
node   test-orders-counted-in-sales-reports/node/flag-test-orders.js
```

`classify_test_order` is a pure function that takes an order and its transaction list and returns `{ isTest, reasons }`, so the decision is fully testable without a network call or a BigCommerce store. The only write is a marker prepended to `staff_notes`, an internal-only field the customer never sees, and it is skipped if the order is already flagged. Start with `DRY_RUN=true` to review the list first. Cancelling a confirmed QA order is a separate, human-confirmed step you take by hand with `PUT /v2/orders/{id} {"status_id": 5}`, never something this script does on its own.

## Test

```bash
pytest test-orders-counted-in-sales-reports/python
node --test test-orders-counted-in-sales-reports/node
```
