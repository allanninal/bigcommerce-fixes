# Shipment tracking never added

POST /v2/orders/{id}/shipments only requires order_address_id and items. tracking_number is optional, alongside tracking_link and shipping_provider. That means the Ship Items modal in the control panel, or a connected OMS or 3PL such as ShipStation, Cin7, or ShipHero, can create a shipment with the Tracking ID box left blank, or an integration can move status_id straight to 2 (Shipped) with PUT /v2/orders/{id} and skip shipment creation entirely. Either way, the order looks fulfilled while the customer has no way to track their package, and the automated shipping confirmation email's tracking link points nowhere. This job lists orders in status_id 2 (Shipped), 3 (Partially Shipped), and 10 (Completed), reads each order's shipments, and flags only the ones older than a grace window that have zero shipment records or whose shipments all carry empty tracking_number, tracking_link, and shipping_provider fields. It never fabricates a tracking number, it only leaves a note for a human to fill in the real one.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/shipment-tracking-never-added/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export LOOKBACK_DAYS="14"
export GRACE_HOURS="24"
export DRY_RUN="true"

python shipment-tracking-never-added/python/find_untracked_shipped_orders.py
node   shipment-tracking-never-added/node/find-untracked-shipped-orders.js
```

`find_untracked_shipped_orders` (`findUntrackedShippedOrders` in Node) is a pure function that takes only the list of orders, a map of shipments by order id, the current time, and a grace period in hours, so it is fully testable without a network call. It only flags an order once it is in status_id 2, 3, or 10, and older than the grace window, and only when the order has zero shipment records (`no_shipment_record`) or every shipment on file has empty tracking_number, tracking_link, and shipping_provider (`shipment_missing_tracking`). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest shipment-tracking-never-added/python
node --test shipment-tracking-never-added/node
```
