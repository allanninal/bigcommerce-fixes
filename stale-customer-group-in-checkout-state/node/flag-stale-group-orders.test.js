import { test } from "node:test";
import assert from "node:assert/strict";
import { isOrderMispriced } from "./flag-stale-group-orders.js";

test("not mispriced when groups match", () => {
  assert.equal(isOrderMispriced(10, 10, 45.0, 50.0), false);
});

test("mispriced when groups diverge and price differs", () => {
  assert.equal(isOrderMispriced(10, 20, 40.0, 50.0), true);
});

test("not mispriced when groups diverge but price is identical", () => {
  assert.equal(isOrderMispriced(10, 20, 50.0, 50.0), false);
});

test("not mispriced within rounding tolerance", () => {
  assert.equal(isOrderMispriced(10, 20, 50.0, 50.005), false);
});

test("mispriced just beyond tolerance", () => {
  assert.equal(isOrderMispriced(10, 20, 50.0, 50.02), true);
});

test("custom tolerance is respected", () => {
  assert.equal(isOrderMispriced(10, 20, 50.0, 50.5, 1.0), false);
});

test("negative delta direction does not matter", () => {
  assert.equal(isOrderMispriced(10, 20, 60.0, 50.0), true);
});

test("exactly at tolerance boundary is not flagged", () => {
  assert.equal(isOrderMispriced(10, 20, 50.0, 50.01), false);
});
