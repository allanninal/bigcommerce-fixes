import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCartDuplicates } from "./reconcile-b2b-carts.js";

const NOW = 1_700_000_000;
const DAY = 86400;

const cart = (cartId, customerId, updatedTime, skus) => ({
  cart_id: cartId,
  customer_id: customerId,
  updated_time: updatedTime,
  line_item_skus: new Set(skus),
});

test("single cart per customer is not a duplicate", () => {
  const carts = [cart("A", 1, NOW, ["SKU-1"])];
  assert.deepEqual(classifyCartDuplicates(carts, NOW), {});
});

test("anonymous carts are never grouped", () => {
  const carts = [cart("A", 0, NOW, ["SKU-1"]), cart("B", null, NOW, ["SKU-2"])];
  assert.deepEqual(classifyCartDuplicates(carts, NOW), {});
});

test("older subset cart is deletable", () => {
  const carts = [
    cart("old", 42, NOW - DAY, ["SKU-1"]),
    cart("new", 42, NOW, ["SKU-1", "SKU-2"]),
  ];
  const result = classifyCartDuplicates(carts, NOW);
  assert.equal(result["42"].canonical, "new");
  assert.deepEqual(result["42"].orphans_deletable, ["old"]);
  assert.deepEqual(result["42"].orphans_needs_merge, []);
});

test("older cart with extra items needs merge", () => {
  const carts = [
    cart("old", 42, NOW - DAY, ["SKU-1", "SKU-9"]),
    cart("new", 42, NOW, ["SKU-1", "SKU-2"]),
  ];
  const result = classifyCartDuplicates(carts, NOW);
  assert.equal(result["42"].canonical, "new");
  assert.deepEqual(result["42"].orphans_deletable, []);
  assert.deepEqual(result["42"].orphans_needs_merge, ["old"]);
});

test("expired carts are dropped before grouping", () => {
  const carts = [
    cart("stale", 7, NOW - 31 * DAY, ["SKU-1"]),
    cart("only-live", 7, NOW, ["SKU-1"]),
  ];
  assert.deepEqual(classifyCartDuplicates(carts, NOW), {});
});

test("three way duplicate group", () => {
  const carts = [
    cart("a", 5, NOW - 2 * DAY, ["SKU-1"]),
    cart("b", 5, NOW - DAY, ["SKU-1", "SKU-9"]),
    cart("c", 5, NOW, ["SKU-1", "SKU-2"]),
  ];
  const result = classifyCartDuplicates(carts, NOW);
  assert.equal(result["5"].canonical, "c");
  assert.deepEqual(result["5"].orphans_deletable, ["a"]);
  assert.deepEqual(result["5"].orphans_needs_merge, ["b"]);
});

test("exact duplicate cart is deletable via subset equality", () => {
  const carts = [
    cart("old", 9, NOW - DAY, ["SKU-1", "SKU-2"]),
    cart("new", 9, NOW, ["SKU-1", "SKU-2"]),
  ];
  const result = classifyCartDuplicates(carts, NOW);
  assert.equal(result["9"].canonical, "new");
  assert.deepEqual(result["9"].orphans_deletable, ["old"]);
  assert.deepEqual(result["9"].orphans_needs_merge, []);
});
