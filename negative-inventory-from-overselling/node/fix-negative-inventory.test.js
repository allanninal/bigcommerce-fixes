import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNegativeInventory } from "./fix-negative-inventory.js";

const product = (over = {}) => ({ id: 701, inventory_tracking: "variant", ...over });
const variant = (over = {}) => ({ id: 9001, sku: "MUG-RED", inventory_level: -3, ...over });

test("needs fix when variant tracked and negative", () => {
  const result = classifyNegativeInventory(product(), variant());
  assert.equal(result.needsFix, true);
  assert.equal(result.oversoldBy, 3);
  assert.equal(result.sku, "MUG-RED");
  assert.equal(result.productId, 701);
  assert.equal(result.variantId, 9001);
});

test("no fix when inventory_level is zero", () => {
  const result = classifyNegativeInventory(product(), variant({ inventory_level: 0 }));
  assert.equal(result.needsFix, false);
  assert.equal(result.oversoldBy, 0);
});

test("no fix when inventory_level is positive", () => {
  const result = classifyNegativeInventory(product(), variant({ inventory_level: 12 }));
  assert.equal(result.needsFix, false);
});

test("no fix when tracking is none", () => {
  const result = classifyNegativeInventory(product({ inventory_tracking: "none" }), variant());
  assert.equal(result.needsFix, false);
  assert.equal(result.oversoldBy, 0);
});

test("no fix when tracking is product level", () => {
  const result = classifyNegativeInventory(product({ inventory_tracking: "product" }), variant());
  assert.equal(result.needsFix, false);
});

test("oversold by matches absolute value of deep negative", () => {
  const result = classifyNegativeInventory(product(), variant({ inventory_level: -41 }));
  assert.equal(result.needsFix, true);
  assert.equal(result.oversoldBy, 41);
});
