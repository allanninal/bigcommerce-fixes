import { test } from "node:test";
import assert from "node:assert/strict";
import { findSkuCollisions } from "./fix-colliding-variant-skus.js";

const variant = ({ product_id = 1, variant_id = 1, sku = "ABC-1", option_values = [] } = {}) => ({
  product_id, variant_id, sku, option_values,
});

test("no collisions when all SKUs are unique", () => {
  const variants = [variant({ variant_id: 1, sku: "ABC-1" }), variant({ variant_id: 2, sku: "ABC-2" })];
  assert.deepEqual(findSkuCollisions(variants), {});
});

test("finds collision within same product", () => {
  const variants = [variant({ variant_id: 1, sku: "ABC-1" }), variant({ variant_id: 2, sku: "ABC-1" })];
  const collisions = findSkuCollisions(variants);
  assert.deepEqual(Object.keys(collisions), ["1:abc-1"]);
  assert.equal(collisions["1:abc-1"].length, 2);
});

test("normalizes SKU case and whitespace", () => {
  const variants = [variant({ variant_id: 1, sku: "  ABC-1  " }), variant({ variant_id: 2, sku: "abc-1" })];
  const collisions = findSkuCollisions(variants);
  assert.equal(collisions["1:abc-1"].length, 2);
});

test("blank SKUs are not collisions", () => {
  const variants = [variant({ variant_id: 1, sku: "" }), variant({ variant_id: 2, sku: "" })];
  assert.deepEqual(findSkuCollisions(variants), {});
});

test("same SKU on different products is not grouped together", () => {
  // Collisions are grouped per product_id, so the same SKU text reused on
  // two different single-variant products is not, by itself, a collision.
  const variants = [
    variant({ product_id: 1, variant_id: 1, sku: "ABC-1" }),
    variant({ product_id: 2, variant_id: 2, sku: "ABC-1" }),
  ];
  assert.deepEqual(findSkuCollisions(variants), {});
});

test("collision detected independently per product", () => {
  const variants = [
    variant({ product_id: 1, variant_id: 1, sku: "ABC-1" }),
    variant({ product_id: 1, variant_id: 2, sku: "ABC-1" }),
    variant({ product_id: 2, variant_id: 3, sku: "ABC-1" }),
    variant({ product_id: 2, variant_id: 4, sku: "ABC-1" }),
  ];
  const collisions = findSkuCollisions(variants);
  assert.ok("1:abc-1" in collisions);
  assert.ok("2:abc-1" in collisions);
  assert.equal(Object.keys(collisions).length, 2);
  assert.equal(collisions["1:abc-1"].length, 2);
  assert.equal(collisions["2:abc-1"].length, 2);
});

test("option values are preserved for reporting", () => {
  const variants = [
    variant({ variant_id: 1, sku: "ABC-1", option_values: [{ option_display_name: "Color", label: "Red" }] }),
    variant({ variant_id: 2, sku: "ABC-1", option_values: [{ option_display_name: "Color", label: "Blue" }] }),
  ];
  const collisions = findSkuCollisions(variants);
  const rows = collisions["1:abc-1"];
  assert.equal(rows[0].option_values[0].label, "Red");
  assert.equal(rows[1].option_values[0].label, "Blue");
});

test("single variant group is not a collision", () => {
  const variants = [variant({ variant_id: 1, sku: "ABC-1" })];
  assert.deepEqual(findSkuCollisions(variants), {});
});

test("blank sku ignored, other two still grouped", () => {
  const variants = [
    variant({ variant_id: 1, sku: "" }),
    variant({ variant_id: 2, sku: "ABC-1" }),
    variant({ variant_id: 3, sku: "ABC-1" }),
  ];
  const collisions = findSkuCollisions(variants);
  assert.equal(Object.keys(collisions).length, 1);
  assert.equal(collisions["1:abc-1"].length, 2);
});
