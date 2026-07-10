import { test } from "node:test";
import assert from "node:assert/strict";
import { planInventoryReconciliation } from "./reconcile-inventory.js";

const variant = (over = {}) => ({
  sku: "SKU-1",
  inventoryLevel: 10,
  inventoryTracking: "variant",
  locationId: 1,
  ...over,
});

test("no adjustment when counted matches inventory level", () => {
  const plan = planInventoryReconciliation([variant()], new Map([["SKU-1", 10]]), new Map());
  assert.deepEqual(plan, []);
});

test("skips sku with no counted source of truth", () => {
  const plan = planInventoryReconciliation([variant()], new Map(), new Map());
  assert.deepEqual(plan, []);
});

test("skips untracked variant", () => {
  const plan = planInventoryReconciliation(
    [variant({ inventoryTracking: "none" })],
    new Map([["SKU-1", 4]]),
    new Map()
  );
  assert.deepEqual(plan, []);
});

test("flags recount variance when no order context", () => {
  const plan = planInventoryReconciliation([variant()], new Map([["SKU-1", 6]]), new Map());
  assert.deepEqual(plan, [{ sku: "SKU-1", locationId: 1, fromQty: 10, toQty: 6, reason: "recount_variance" }]);
});

test("flags cancelled not restocked when order flag present", () => {
  const flags = new Map([["SKU-1", [{ statusId: 5, restocked: false }]]]);
  const plan = planInventoryReconciliation([variant()], new Map([["SKU-1", 12]]), flags);
  assert.equal(plan[0].reason, "cancelled_not_restocked");
});

test("recount variance when order was restocked", () => {
  const flags = new Map([["SKU-1", [{ statusId: 5, restocked: true }]]]);
  const plan = planInventoryReconciliation([variant()], new Map([["SKU-1", 12]]), flags);
  assert.equal(plan[0].reason, "recount_variance");
});

test("recount variance when status is not a restock status", () => {
  const flags = new Map([["SKU-1", [{ statusId: 11, restocked: false }]]]);
  const plan = planInventoryReconciliation([variant()], new Map([["SKU-1", 12]]), flags);
  assert.equal(plan[0].reason, "recount_variance");
});

test("matches any of the four restock statuses", () => {
  for (const statusId of [4, 5, 6, 14]) {
    const flags = new Map([["SKU-1", [{ statusId, restocked: false }]]]);
    const plan = planInventoryReconciliation([variant()], new Map([["SKU-1", 3]]), flags);
    assert.equal(plan[0].reason, "cancelled_not_restocked");
  }
});

test("multiple variants only drifted ones emitted", () => {
  const variants = [variant({ sku: "A", inventoryLevel: 5 }), variant({ sku: "B", inventoryLevel: 5 })];
  const counted = new Map([["A", 5], ["B", 2]]);
  const plan = planInventoryReconciliation(variants, counted, new Map());
  assert.equal(plan.length, 1);
  assert.equal(plan[0].sku, "B");
  assert.equal(plan[0].toQty, 2);
});

test("location id carried through", () => {
  const plan = planInventoryReconciliation([variant({ locationId: 7 })], new Map([["SKU-1", 1]]), new Map());
  assert.equal(plan[0].locationId, 7);
});
