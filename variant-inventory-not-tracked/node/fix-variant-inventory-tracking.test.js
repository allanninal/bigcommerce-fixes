import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVariantTracking, allVariantsHaveStock } from "./fix-variant-inventory-tracking.js";

const product = (over = {}) => ({
  id: 501,
  inventory_tracking: "none",
  variants: [
    { id: 1, sku: "SHIRT-S", inventory_level: 5 },
    { id: 2, sku: "SHIRT-M", inventory_level: 3 },
  ],
  ...over,
});

test("needs fix when tracking none with multiple variants", () => {
  const result = classifyVariantTracking(product());
  assert.equal(result.needsFix, true);
  assert.equal(result.reason, "tracking_disabled_entirely");
  assert.deepEqual(result.affectedVariantIds, [1, 2]);
});

test("needs fix when tracking product level", () => {
  const result = classifyVariantTracking(product({ inventory_tracking: "product" }));
  assert.equal(result.needsFix, true);
  assert.equal(result.reason, "tracking_set_to_product_level_not_variant");
});

test("no fix when already tracking variant", () => {
  const result = classifyVariantTracking(product({ inventory_tracking: "variant" }));
  assert.deepEqual(result, { productId: 501, needsFix: false, reason: null, affectedVariantIds: [] });
});

test("no fix when single default variant", () => {
  const single = product({ variants: [{ id: 1, sku: "SIMPLE", inventory_level: 10 }] });
  assert.equal(classifyVariantTracking(single).needsFix, false);
});

test("no fix when no variants at all", () => {
  assert.equal(classifyVariantTracking(product({ variants: [] })).needsFix, false);
});

test("affected variant ids include every variant", () => {
  const three = product({
    variants: [
      { id: 1, sku: "A", inventory_level: 1 },
      { id: 2, sku: "B", inventory_level: 0 },
      { id: 3, sku: "C", inventory_level: null },
    ],
  });
  const result = classifyVariantTracking(three);
  assert.equal(result.needsFix, true);
  assert.deepEqual(result.affectedVariantIds, [1, 2, 3]);
});

test("tracking product level with two variants needs fix", () => {
  const result = classifyVariantTracking(
    product({
      inventory_tracking: "product",
      variants: [
        { id: 10, sku: "X", inventory_level: 0 },
        { id: 11, sku: "Y", inventory_level: 2 },
      ],
    })
  );
  assert.equal(result.needsFix, true);
  assert.equal(result.reason, "tracking_set_to_product_level_not_variant");
  assert.deepEqual(result.affectedVariantIds, [10, 11]);
});

test("all variants have stock true when every variant has a level", () => {
  const variants = [
    { id: 1, sku: "A", inventory_level: 5 },
    { id: 2, sku: "B", inventory_level: 0 },
  ];
  assert.equal(allVariantsHaveStock(variants, [1, 2]), true);
});

test("all variants have stock false when a variant is missing a level", () => {
  const variants = [
    { id: 1, sku: "A", inventory_level: 5 },
    { id: 2, sku: "B", inventory_level: null },
  ];
  assert.equal(allVariantsHaveStock(variants, [1, 2]), false);
});

test("all variants have stock false when variant id not found", () => {
  const variants = [{ id: 1, sku: "A", inventory_level: 5 }];
  assert.equal(allVariantsHaveStock(variants, [1, 2]), false);
});
