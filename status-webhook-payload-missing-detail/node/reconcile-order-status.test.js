import { test } from "node:test";
import assert from "node:assert/strict";
import { diffOrderStatus } from "./reconcile-order-status.js";

const order = ({ id = 1, status_id = 11, date_modified = "2026-07-10T12:00:00" } = {}) => ({
  id, status_id, date_modified,
});

test("no local record is a mismatch", () => {
  const result = diffOrderStatus(new Map(), [order({ id: 1, status_id: 11 })]);
  assert.deepEqual(result, [{
    order_id: 1,
    previous_known_status_id: null,
    current_status_id: 11,
    date_modified: "2026-07-10T12:00:00",
  }]);
});

test("matching status is a no-op", () => {
  const known = new Map([[1, 11]]);
  const result = diffOrderStatus(known, [order({ id: 1, status_id: 11 })]);
  assert.deepEqual(result, []);
});

test("stale status is a mismatch", () => {
  const known = new Map([[1, 7]]);
  const result = diffOrderStatus(known, [order({ id: 1, status_id: 11 })]);
  assert.deepEqual(result, [{
    order_id: 1,
    previous_known_status_id: 7,
    current_status_id: 11,
    date_modified: "2026-07-10T12:00:00",
  }]);
});

test("empty fetched orders returns empty list", () => {
  assert.deepEqual(diffOrderStatus(new Map([[1, 11]]), []), []);
});

test("mixed batch only flags the mismatches", () => {
  const known = new Map([[1, 11], [2, 7]]);
  const fetched = [order({ id: 1, status_id: 11 }), order({ id: 2, status_id: 10 }), order({ id: 3, status_id: 5 })];
  const result = diffOrderStatus(known, fetched);
  const orderIds = result.map((m) => m.order_id).sort();
  assert.deepEqual(orderIds, [2, 3]);
});
