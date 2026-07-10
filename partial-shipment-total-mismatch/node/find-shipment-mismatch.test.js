import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShipmentMismatch } from "./find-shipment-mismatch.js";

test("ok when everything ties out and not partial", () => {
  assert.equal(classifyShipmentMismatch(10, 10, 0, 10, 2), "ok");
});

test("ok when partial and consistent", () => {
  assert.equal(classifyShipmentMismatch(10, 4, 0, 4, 3), "ok");
});

test("ledger drift when ledger disagrees with cached counter", () => {
  assert.equal(classifyShipmentMismatch(10, 6, 0, 8, 3), "ledger_drift");
});

test("over fulfilled when shipped plus refunded exceeds ordered", () => {
  assert.equal(classifyShipmentMismatch(10, 8, 5, 8, 2), "over_fulfilled");
});

test("stuck partial done when fully shipped but status still partial", () => {
  assert.equal(classifyShipmentMismatch(10, 10, 0, 10, 3), "stuck_partial_done");
});

test("stuck partial unshipped when nothing moved but status is partial", () => {
  assert.equal(classifyShipmentMismatch(10, 0, 0, 0, 3), "stuck_partial_unshipped");
});

test("ledger drift takes priority over stuck partial done", () => {
  assert.equal(classifyShipmentMismatch(10, 10, 0, 7, 3), "ledger_drift");
});

test("over fulfilled takes priority when ledger also agrees", () => {
  assert.equal(classifyShipmentMismatch(10, 9, 2, 9, 2), "over_fulfilled");
});

test("ok when status is shipped and everything matches", () => {
  assert.equal(classifyShipmentMismatch(5, 5, 0, 5, 2), "ok");
});

test("stuck partial unshipped not triggered when refund present", () => {
  assert.equal(classifyShipmentMismatch(10, 0, 10, 0, 3), "ok");
});
