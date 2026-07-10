import { test } from "node:test";
import assert from "node:assert/strict";
import { findOverdueOrders } from "./find-overdue-awaiting-shipment.js";

const NOW = new Date("2026-07-10T00:00:00Z");

function order({ orderId = 1, statusId = 9, hoursAgo = 72, hasShipment = false, paymentStatus = "captured" } = {}) {
  return {
    id: orderId,
    status_id: statusId,
    date_created: new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(),
    has_shipment: hasShipment,
    payment_status: paymentStatus,
  };
}

test("flags order past the SLA", () => {
  const result = findOverdueOrders([order({ hoursAgo: 72 })], NOW, 48);
  assert.equal(result.length, 1);
  assert.equal(result[0].orderId, 1);
  assert.equal(result[0].overageHours, 24);
});

test("exactly at threshold is not overdue", () => {
  const result = findOverdueOrders([order({ hoursAgo: 48 })], NOW, 48);
  assert.deepEqual(result, []);
});

test("already shipped but stale status is excluded", () => {
  const result = findOverdueOrders([order({ hoursAgo: 200, hasShipment: true })], NOW, 48);
  assert.deepEqual(result, []);
});

test("unpaid but wrong status_id is excluded", () => {
  const result = findOverdueOrders([order({ hoursAgo: 200, paymentStatus: "uncaptured" })], NOW, 48);
  assert.deepEqual(result, []);
});

test("multi status_id inputs both kept", () => {
  const orders = [
    order({ orderId: 1, statusId: 9, hoursAgo: 100 }),
    order({ orderId: 2, statusId: 11, hoursAgo: 60 }),
  ];
  const result = findOverdueOrders(orders, NOW, 48);
  assert.deepEqual(new Set(result.map((r) => r.orderId)), new Set([1, 2]));
});

test("ignores status_ids outside the target set", () => {
  const result = findOverdueOrders([order({ statusId: 8, hoursAgo: 200 })], NOW, 48);
  assert.deepEqual(result, []);
});

test("sorted worst breach first", () => {
  const orders = [
    order({ orderId: 1, hoursAgo: 60 }),  // 12h over
    order({ orderId: 2, hoursAgo: 120 }), // 72h over
    order({ orderId: 3, hoursAgo: 90 }),  // 42h over
  ];
  const result = findOverdueOrders(orders, NOW, 48);
  assert.deepEqual(result.map((r) => r.orderId), [2, 3, 1]);
});
