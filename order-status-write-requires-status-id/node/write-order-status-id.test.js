import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStatusId } from "./write-order-status-id.js";

const STATUS_MAP = {
  incomplete: 0, pending: 1, shipped: 2, "partially shipped": 3,
  refunded: 4, cancelled: 5, declined: 6, "awaiting payment": 7,
  "awaiting pickup": 8, "awaiting shipment": 9, completed: 10,
  "awaiting fulfillment": 11, "manual verification required": 12,
  disputed: 13, "partially refunded": 14,
};

test("resolves valid int status_id", () => {
  assert.equal(resolveStatusId(2, STATUS_MAP), 2);
});

test("rejects out of range int status_id", () => {
  assert.equal(resolveStatusId(999, STATUS_MAP), null);
});

test("rejects negative int status_id", () => {
  assert.equal(resolveStatusId(-1, STATUS_MAP), null);
});

test("resolves case-insensitive name", () => {
  assert.equal(resolveStatusId("Shipped", STATUS_MAP), 2);
  assert.equal(resolveStatusId("  shipped  ", STATUS_MAP), 2);
});

test("resolves numeric string", () => {
  assert.equal(resolveStatusId("11", STATUS_MAP), 11);
});

test("unknown name returns null, not the string", () => {
  const result = resolveStatusId("Shipped Today", STATUS_MAP);
  assert.equal(result, null);
  assert.notEqual(typeof result, "string");
});

test("boolean is never treated as a valid status_id", () => {
  assert.equal(resolveStatusId(true, STATUS_MAP), null);
  assert.equal(resolveStatusId(false, STATUS_MAP), null);
});

test("custom label resolves when present in the map", () => {
  const customMap = { ...STATUS_MAP, "ready to pack": 11 };
  assert.equal(resolveStatusId("Ready to Pack", customMap), 11);
});

test("null desired returns null", () => {
  assert.equal(resolveStatusId(null, STATUS_MAP), null);
});
