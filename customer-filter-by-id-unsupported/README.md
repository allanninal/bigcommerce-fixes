# Customers filter by id is rejected as unsupported

BigCommerce's v2 Customers resource (`GET /v2/customers`) only accepts a fixed, documented set of filter query params, email, name, company, date_created, and so on. The `id` field was never implemented as a filterable field on that legacy list endpoint, unlike the v3 Customers API, which supports the `id:in=1,2,3` filter syntax natively. Scripts and SDKs that assume v3-style filter conventions work uniformly across versions pass `?id=123` to v2 and get a 400, "The field 'id' is not supported by this resource.", because v2's query-string filter whitelist simply omits id. This is a client-side query-shape bug, not corrupt store data, so there is nothing on the BigCommerce side to write or repair. This job attempts the v2 id filter, and on the specific 400 it reconciles a single id through the direct resource path `GET /v2/customers/{id}`, or signals a migration to the v3 batched `id:in` filter for multiple ids.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/customer-filter-by-id-unsupported/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python customer-filter-by-id-unsupported/python/reconcile_customer_id_filter.py
node   customer-filter-by-id-unsupported/node/reconcile-customer-id-filter.js
```

`resolve_customer_lookup` (`resolveCustomerLookup` in Node) is a pure function that takes the api version, the filter query, the response status, and the error field reported in a 400 body, so it is fully testable without a network call. It returns `ok_list_filter` when the call is fine as is (always true on v3), `fallback_direct_resource` when a v2 id filter was rejected for a single id, or `migrate_to_v3` when a v2 id filter was rejected for multiple ids. Start with `DRY_RUN=true` to review the reconciliation plan first, this job only reads, there is nothing to write.

## Test

```bash
pytest customer-filter-by-id-unsupported/python
node --test customer-filter-by-id-unsupported/node
```
