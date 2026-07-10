import { test } from "node:test";
import assert from "node:assert/strict";
import { isStranded } from "./fix-stranded-products.js";

const product = (over = {}) => ({ id: 501, name: "Sample Widget", categories: [12], ...over });

test("not stranded when it has a category", () => {
  assert.equal(isStranded(product()), false);
});

test("stranded when categories is empty list", () => {
  assert.equal(isStranded(product({ categories: [] })), true);
});

test("stranded when categories is missing", () => {
  const p = product();
  delete p.categories;
  assert.equal(isStranded(p), true);
});

test("stranded when categories is null", () => {
  assert.equal(isStranded(product({ categories: null })), true);
});

test("not stranded with multiple categories", () => {
  assert.equal(isStranded(product({ categories: [3, 7, 12] })), false);
});
