import { test } from "node:test";
import assert from "node:assert/strict";
import { findStaleVariantOverrides } from "./find-stale-variant-prices.js";

const makeProduct = (price = "50.0000") => ({ id: 100, price });
const makeVariant = (id = 1, sku = "SKU-1", price = null) => ({ id, sku, price });

test("no findings when variant price is null", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(1, "SKU-1", null)];
  assert.deepEqual(findStaleVariantOverrides(product, variants), []);
});

test("no findings when variant price is empty string", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(1, "SKU-1", "")];
  assert.deepEqual(findStaleVariantOverrides(product, variants), []);
});

test("no findings when variant price matches product price", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(1, "SKU-1", "50.0000")];
  assert.deepEqual(findStaleVariantOverrides(product, variants), []);
});

test("finding when variant price diverges", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(7, "SKU-7", "45.0000")];
  const result = findStaleVariantOverrides(product, variants);
  assert.deepEqual(result, [{
    variant_id: 7,
    sku: "SKU-7",
    product_price: "50.0000",
    variant_price: "45.0000",
    delta: "-5.0000",
  }]);
});

test("finding delta is positive when variant price is higher", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(8, "SKU-8", "62.5000")];
  const result = findStaleVariantOverrides(product, variants);
  assert.equal(result[0].delta, "12.5000");
});

test("within epsilon is not a finding", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(1, "SKU-1", "50.00005")];
  assert.deepEqual(findStaleVariantOverrides(product, variants, "0.0001"), []);
});

test("just outside epsilon is a finding", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(1, "SKU-1", "50.0002")];
  const result = findStaleVariantOverrides(product, variants, "0.0001");
  assert.equal(result.length, 1);
});

test("multiple variants only flags the diverging ones", () => {
  const product = makeProduct("50.0000");
  const variants = [
    makeVariant(1, "SKU-1", null),
    makeVariant(2, "SKU-2", "50.0000"),
    makeVariant(3, "SKU-3", "55.0000"),
  ];
  const result = findStaleVariantOverrides(product, variants);
  assert.deepEqual(result.map((f) => f.variant_id), [3]);
});

test("missing product price returns no findings", () => {
  const product = { id: 100 };
  const variants = [makeVariant(1, "SKU-1", "45.0000")];
  assert.deepEqual(findStaleVariantOverrides(product, variants), []);
});

test("unparseable variant price is skipped not thrown", () => {
  const product = makeProduct("50.0000");
  const variants = [makeVariant(1, "SKU-1", "not-a-number")];
  assert.deepEqual(findStaleVariantOverrides(product, variants), []);
});
