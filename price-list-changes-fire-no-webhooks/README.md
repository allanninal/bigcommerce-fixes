# Price list changes fire no product or SKU webhooks

BigCommerce Price Lists are a pricing overlay resolved at cart and storefront time, not a mutation of the base catalog object. Writing a record with POST or PUT to `/v3/pricelists/{price_list_id}/records` never touches the product or variant row, so it never bumps date_modified and never emits store/product/updated or store/sku/updated. Price list changes instead fire their own webhook family, store/priceList/record/created, store/priceList/record/updated, and store/priceList/record/deleted for single writes, and store/priceList/records/created for batch writes, which most catalog-sync integrations never subscribe to because they assumed all pricing changes surface through the product/SKU scopes they already listen on. This job checks which scopes are actually active, snapshots every price list's records, diffs the snapshot against the previous run, and reports every changed record where the active scopes prove the change was invisible to catalog webhooks. It never writes to the catalog and never synthesizes a product or SKU event.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/price-list-changes-fire-no-webhooks/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export SNAPSHOT_PATH="price_list_snapshot.json"
export HOOK_DESTINATION="https://your-integration.example.com/webhooks/bigcommerce"
export DRY_RUN="true"

python price-list-changes-fire-no-webhooks/python/detect_price_list_webhook_gap.py
node   price-list-changes-fire-no-webhooks/node/detect-price-list-webhook-gap.js
```

`diff_price_list_records` (`diffPriceListRecords` in Node) is a pure function that takes only a previous snapshot, a current snapshot, and the set of active webhook scopes, so it is fully testable without a network call. It returns a finding for every changed (price_list_id, variant_id) pair, and flags `webhook_gap: true` only when the store watches store/product/updated or store/sku/updated but has none of the store/priceList/record/* or store/priceList/records/created scopes registered. Start with `DRY_RUN=true` to review the findings and confirm HOOK_DESTINATION before letting the job register any missing hook subscriptions.

## Test

```bash
pytest price-list-changes-fire-no-webhooks/python
node --test price-list-changes-fire-no-webhooks/node
```
