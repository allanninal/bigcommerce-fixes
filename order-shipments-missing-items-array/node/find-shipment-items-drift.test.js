import { test } from "node:test";
import assert from "node:assert/strict";
import { findItemsDrift } from "./find-shipment-items-drift.js";

const rawShipment = ({ items, shipmentId = 1, orderId = 100 } = {}) => ({
  id: shipmentId,
  order_id: orderId,
  tracking_number: "1Z999AA10123456784",
  order_address_id: 5,
  items: items !== undefined ? items : [
    { order_product_id: 11, product_id: 200, quantity: 2 },
  ],
});

test("no drift when mapped items matches raw", () => {
  const raw = rawShipment();
  const mapped = { id: 1, order_id: 100, items: raw.items };
  assert.equal(findItemsDrift(raw, mapped), null);
});

test("no drift when raw items is empty", () => {
  const raw = rawShipment({ items: [] });
  const mapped = { id: 1, order_id: 100 };
  assert.equal(findItemsDrift(raw, mapped), null);
});

test("drift when mapped items missing", () => {
  const raw = rawShipment();
  const mapped = { id: 1, order_id: 100, tracking_number: "1Z999AA10123456784" };
  const drift = findItemsDrift(raw, mapped);
  assert.notEqual(drift, null);
  assert.equal(drift.shipmentId, 1);
  assert.equal(drift.rawItemCount, 1);
  assert.equal(drift.rawShippedQuantity, 2);
  assert.deepEqual(drift.orderProductIds, [11]);
});

test("drift when mapped items is null", () => {
  const raw = rawShipment();
  const mapped = { id: 1, order_id: 100, items: null };
  const drift = findItemsDrift(raw, mapped);
  assert.notEqual(drift, null);
  assert.equal(drift.mappedItemsValue, null);
});

test("drift when mapped items is empty list", () => {
  const raw = rawShipment();
  const mapped = { id: 1, order_id: 100, items: [] };
  const drift = findItemsDrift(raw, mapped);
  assert.notEqual(drift, null);
  assert.deepEqual(drift.mappedItemsValue, []);
});

test("sums quantity across multiple items", () => {
  const raw = rawShipment({
    items: [
      { order_product_id: 11, product_id: 200, quantity: 2 },
      { order_product_id: 12, product_id: 201, quantity: 3 },
    ],
  });
  const mapped = { id: 1, order_id: 100 };
  const drift = findItemsDrift(raw, mapped);
  assert.equal(drift.rawShippedQuantity, 5);
  assert.deepEqual(drift.orderProductIds, [11, 12]);
});

test("no drift when raw items key is missing", () => {
  const raw = { id: 1, order_id: 100 };
  const mapped = { id: 1, order_id: 100 };
  assert.equal(findItemsDrift(raw, mapped), null);
});

test("drift when mapped items is not an array", () => {
  const raw = rawShipment();
  const mapped = { id: 1, order_id: 100, items: "not-a-list" };
  const drift = findItemsDrift(raw, mapped);
  assert.notEqual(drift, null);
  assert.equal(drift.mappedItemsValue, "not-a-list");
});
