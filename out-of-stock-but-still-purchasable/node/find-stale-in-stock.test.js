import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleInStock } from "./find-stale-in-stock.js";

test("flags when tracked at product level, zero, and available", () => {
  assert.equal(isStaleInStock("product", 0, "available", false), true);
});

test("flags when tracked at variant level, negative, and available", () => {
  assert.equal(isStaleInStock("variant", -1, "available", false), true);
});

test("no flag when tracking is none", () => {
  assert.equal(isStaleInStock("none", 0, "available", false), false);
});

test("no flag when still in stock", () => {
  assert.equal(isStaleInStock("product", 5, "available", false), false);
});

test("no flag when already disabled", () => {
  assert.equal(isStaleInStock("product", 0, "disabled", false), false);
});

test("no flag when purchasing already disabled", () => {
  assert.equal(isStaleInStock("variant", 0, "available", true), false);
});

test("no flag when preorder availability", () => {
  assert.equal(isStaleInStock("product", 0, "preorder", false), false);
});
