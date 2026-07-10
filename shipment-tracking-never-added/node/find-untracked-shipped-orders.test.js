import { test } from "node:test";
import assert from "node:assert/strict";
import { findUntrackedShippedOrders } from "./find-untracked-shipped-orders.js";

const NOW = new Date("2026-07-10T00:00:00Z");

function order({ orderId = 1, statusId = 2, hoursAgo = 48 } = {}) {
  return {
    id: orderId,
    status_id: statusId,
    date_modified: new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(),
  };
}

test("flags order with no shipment record", () => {
  const result = findUntrackedShippedOrders([order()], new Map(), NOW);
  assert.deepEqual(result, [{ orderId: 1, reason: "no_shipment_record" }]);
});

test("flags order whose shipment has no tracking", () => {
  const shipments = new Map([[1, [{ tracking_number: "", tracking_link: "", shipping_provider: "" }]]]);
  const result = findUntrackedShippedOrders([order()], shipments, NOW);
  assert.deepEqual(result, [{ orderId: 1, reason: "shipment_missing_tracking" }]);
});

test("does not flag order with real tracking", () => {
  const shipments = new Map([[1, [{ tracking_number: "1Z999", tracking_link: "", shipping_provider: "ups" }]]]);
  const result = findUntrackedShippedOrders([order()], shipments, NOW);
  assert.deepEqual(result, []);
});

test("does not flag within grace window", () => {
  const result = findUntrackedShippedOrders([order({ hoursAgo: 2 })], new Map(), NOW, 24);
  assert.deepEqual(result, []);
});

test("ignores orders not in shipped-like statuses", () => {
  const result = findUntrackedShippedOrders([order({ statusId: 11 })], new Map(), NOW);
  assert.deepEqual(result, []);
});

test("flags partially shipped and completed too", () => {
  const orders = [order({ orderId: 2, statusId: 3 }), order({ orderId: 3, statusId: 10 })];
  const result = findUntrackedShippedOrders(orders, new Map(), NOW);
  assert.deepEqual(new Set(result.map((r) => r.orderId)), new Set([2, 3]));
});

test("one shipment with tracking clears the order even if another lacks it", () => {
  const shipments = new Map([
    [
      1,
      [
        { tracking_number: "", tracking_link: "", shipping_provider: "" },
        { tracking_number: "1Z999", tracking_link: "", shipping_provider: "ups" },
      ],
    ],
  ]);
  const result = findUntrackedShippedOrders([order()], shipments, NOW);
  assert.deepEqual(result, []);
});

test("empty orders list returns empty", () => {
  const result = findUntrackedShippedOrders([], new Map(), NOW);
  assert.deepEqual(result, []);
});

test("missing shipments entry treated as no shipment record", () => {
  const result = findUntrackedShippedOrders([order({ orderId: 99 })], new Map(), NOW);
  assert.deepEqual(result, [{ orderId: 99, reason: "no_shipment_record" }]);
});
