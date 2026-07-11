import { test } from "node:test";
import assert from "node:assert/strict";
import { isInventoryCorrupted, buildCorrectionPayload } from "./reconcile-concurrent-inventory-drift.js";

test("not corrupted when actual matches expected", () => {
  assert.equal(isInventoryCorrupted(50, 50), false);
});

test("not corrupted within tolerance", () => {
  assert.equal(isInventoryCorrupted(48, 50, 2), false);
});

test("corrupted when actual drifts above tolerance", () => {
  assert.equal(isInventoryCorrupted(45, 50, 2), true);
});

test("corrupted when actual is higher than expected", () => {
  assert.equal(isInventoryCorrupted(70, 50), true);
});

test("not corrupted at exact tolerance boundary", () => {
  assert.equal(isInventoryCorrupted(52, 50, 2), false);
});

test("correction payload has exact shape", () => {
  const payload = buildCorrectionPayload("SKU-123", 7, 50);
  assert.deepEqual(payload, { location_id: 7, sku: "SKU-123", quantity: 50 });
});

test("correction payload uses expected on hand as quantity", () => {
  const payload = buildCorrectionPayload("SKU-999", 1, 0);
  assert.equal(payload.quantity, 0);
});
