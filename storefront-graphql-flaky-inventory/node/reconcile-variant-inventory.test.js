import { test } from "node:test";
import assert from "node:assert/strict";
import { diffVariantStock } from "./reconcile-variant-inventory.js";

test("in_sync when values match", () => {
  assert.deepEqual(diffVariantStock(10, 10, 5, 0), { status: "in_sync", delta: 0 });
});

test("transient on first mismatch", () => {
  assert.deepEqual(diffVariantStock(12, 4, 5, 0), { status: "transient", delta: 8 });
});

test("transient below min stable polls", () => {
  assert.deepEqual(diffVariantStock(12, 4, 5, 1, 2), { status: "transient", delta: 8 });
});

test("flag once min stable polls reached", () => {
  assert.deepEqual(diffVariantStock(12, 4, 5, 2, 2), { status: "flag", delta: 8 });
});

test("flag when graphql reports null and stable", () => {
  assert.deepEqual(diffVariantStock(null, 7, 5, 2, 2), { status: "flag", delta: 7 });
});

test("negative delta when graphql overreports", () => {
  assert.deepEqual(diffVariantStock(2, 9, 5, 2, 2), { status: "flag", delta: -7 });
});

test("zero stock both sides is in sync", () => {
  assert.deepEqual(diffVariantStock(0, 0, 0, 0), { status: "in_sync", delta: 0 });
});

test("min stable polls default is two", () => {
  assert.equal(diffVariantStock(12, 4, 5, 1).status, "transient");
  assert.equal(diffVariantStock(12, 4, 5, 2).status, "flag");
});
