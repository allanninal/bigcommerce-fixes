import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateOrderGroups } from "./find-duplicate-orders.js";

const order = (id, { customerId = 1, minute = 0, second = 0, total = "49.99", statusId = 1, sig = "10x1" } = {}) => ({
  id,
  customer_id: customerId,
  date_created: `2026-07-10T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`,
  total_inc_tax: total,
  status_id: statusId,
  product_signature: sig,
});

test("two close orders form a duplicate group", () => {
  const orders = [order(1001, { second: 0 }), order(1002, { second: 20 })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), [[1001, 1002]]);
});

test("orders far apart are not grouped", () => {
  const orders = [order(1001, { minute: 0 }), order(1002, { minute: 20 })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), []);
});

test("different totals are not grouped", () => {
  const orders = [order(1001, { second: 0, total: "49.99" }), order(1002, { second: 20, total: "59.99" })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), []);
});

test("different customers are not grouped", () => {
  const orders = [order(1001, { customerId: 1, second: 0 }), order(1002, { customerId: 2, second: 20 })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), []);
});

test("shipped orders are ignored", () => {
  const orders = [order(1001, { second: 0, statusId: 2 }), order(1002, { second: 20, statusId: 2 })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), []);
});

test("three in a row form one cluster", () => {
  const orders = [order(1001, { second: 0 }), order(1002, { second: 10 }), order(1003, { second: 20 })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), [[1001, 1002, 1003]]);
});

test("different product signatures are not grouped", () => {
  const orders = [order(1001, { second: 0, sig: "10x1" }), order(1002, { second: 20, sig: "11x1" })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), []);
});

test("keeper is the earliest order in the cluster", () => {
  const orders = [order(1002, { second: 20 }), order(1001, { second: 0 })];
  assert.deepEqual(findDuplicateOrderGroups(orders, 300), [[1001, 1002]]);
});
