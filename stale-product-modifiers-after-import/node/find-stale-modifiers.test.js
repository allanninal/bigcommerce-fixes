import { test } from "node:test";
import assert from "node:assert/strict";
import { findStaleModifiers } from "./find-stale-modifiers.js";

const modifier = (id, { type = "text", is_required = false, option_values = [] } = {}) => ({
  id, type, is_required, option_values,
});

const value = ({ sku, product_id } = {}) => {
  const data = {};
  if (sku !== undefined) data.sku = sku;
  if (product_id !== undefined) data.product_id = product_id;
  return { value_data: data };
};

test("not stale when all references are live", () => {
  const mods = [modifier(1, { option_values: [value({ sku: "ABC-1" })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(["ABC-1"]), new Set()), []);
});

test("stale when sku missing from live variants", () => {
  const mods = [modifier(1, { option_values: [value({ sku: "OLD-SKU" })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(["ABC-1"]), new Set()), mods);
});

test("stale when product_list references dead product id", () => {
  const mods = [modifier(2, { type: "product_list", option_values: [value({ product_id: 99 })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(), new Set([1, 2, 3])), mods);
});

test("not stale when product_list references live product id", () => {
  const mods = [modifier(2, { type: "product_list", option_values: [value({ product_id: 1 })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(), new Set([1, 2, 3])), []);
});

test("required with zero option_values is stale", () => {
  const mods = [modifier(3, { is_required: true, option_values: [] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(), new Set()), mods);
});

test("optional with zero option_values is not flagged", () => {
  const mods = [modifier(4, { is_required: false, option_values: [] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(), new Set()), []);
});

test("ignores type other than product_list for product id check", () => {
  const mods = [modifier(5, { type: "text", option_values: [value({ product_id: 99 })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(), new Set([1, 2, 3])), []);
});

test("multiple modifiers only flags the stale one", () => {
  const fine = modifier(6, { option_values: [value({ sku: "ABC-1" })] });
  const stale = modifier(7, { option_values: [value({ sku: "GONE" })] });
  assert.deepEqual(findStaleModifiers([fine, stale], new Set(["ABC-1"]), new Set()), [stale]);
});

test("product_list_with_images type is also checked", () => {
  const mods = [modifier(8, { type: "product_list_with_images", option_values: [value({ product_id: 42 })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(), new Set([1, 2, 3])), mods);
});

test("multiple option values any dead one flags modifier", () => {
  const mods = [modifier(9, { option_values: [value({ sku: "ABC-1" }), value({ sku: "GONE" })] })];
  assert.deepEqual(findStaleModifiers(mods, new Set(["ABC-1"]), new Set()), mods);
});
