# Orders stuck Awaiting Shipment past SLA

BigCommerce moves a paid order into status_id 11 (Awaiting Fulfillment) automatically once payment captures, and merchants or OMS integrations move it to status_id 9 (Awaiting Shipment) once picked and packed. Neither status has a built-in SLA clock or aging alert, so an order only leaves Awaiting Shipment when someone explicitly posts a shipment. Orders age silently past a shipping promise whenever a warehouse task is missed, a 3PL or OMS sync fails, or the store/order/statusUpdated webhook that would have notified an external fulfillment system was auto-deactivated by BigCommerce after repeated non-2xx responses and never recreated. This job lists orders in status_id 9, 11, and 8, confirms each candidate's payment actually settled and that no shipment already exists, computes how far past the SLA it is, and flags only the genuinely overdue ones with a note on staff_notes. It never marks an order shipped and never fabricates a shipment record.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/orders-stuck-awaiting-shipment-past-sla/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export SLA_HOURS="48"
export DRY_RUN="true"

python orders-stuck-awaiting-shipment-past-sla/python/find_overdue_awaiting_shipment.py
node   orders-stuck-awaiting-shipment-past-sla/node/find-overdue-awaiting-shipment.js
```

`find_overdue_orders` (`findOverdueOrders` in Node) is a pure function that takes only the list of orders already enriched with `has_shipment` and `payment_status`, the current time, and the SLA in hours, so it is fully testable without a network call. It filters to status_id 9 or 11, excludes any order that already has a shipment or whose payment is not captured, computes `age_hours` from `date_created`, and keeps only the orders older than `sla_hours`, sorted by `overage_hours` descending so the worst breaches surface first. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest orders-stuck-awaiting-shipment-past-sla/python
node --test orders-stuck-awaiting-shipment-past-sla/node
```
