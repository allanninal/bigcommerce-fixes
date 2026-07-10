import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStaleCart } from "./clean-stale-carts.js";

const NOW = "2026-07-10T00:00:00Z";

const cart = ({ updatedTime = "2026-07-09T00:00:00Z", physical = 1, digital = 0, custom = 0, giftCert = 0 } = {}) => ({
  id: "cart-1",
  customerId: 42,
  email: "buyer@example.com",
  createdTime: updatedTime,
  updatedTime,
  lineItemCounts: { physical, digital, custom, giftCert },
});

test("active when recent and has items", () => {
  const result = classifyStaleCart(cart({ updatedTime: "2026-07-09T00:00:00Z" }), false, NOW, 30);
  assert.deepEqual(result, { isStale: false, reason: "active" });
});

test("empty cart past threshold is safe to delete", () => {
  const c = cart({ updatedTime: "2026-05-01T00:00:00Z", physical: 0 });
  const result = classifyStaleCart(c, false, NOW, 30);
  assert.deepEqual(result, { isStale: true, reason: "empty_cart" });
});

test("empty but recent is active", () => {
  const c = cart({ updatedTime: "2026-07-05T00:00:00Z", physical: 0 });
  const result = classifyStaleCart(c, false, NOW, 30);
  assert.equal(result.isStale, false);
});

test("converted duplicate regardless of age", () => {
  const c = cart({ updatedTime: "2026-07-09T00:00:00Z", physical: 2 });
  const result = classifyStaleCart(c, true, NOW, 30);
  assert.deepEqual(result, { isStale: true, reason: "converted_duplicate" });
});

test("converted duplicate beats empty cart reason", () => {
  const c = cart({ updatedTime: "2026-05-01T00:00:00Z", physical: 0 });
  const result = classifyStaleCart(c, true, NOW, 30);
  assert.deepEqual(result, { isStale: true, reason: "empty_cart" });
});

test("abandoned stale has items, old, and no order", () => {
  const c = cart({ updatedTime: "2026-05-01T00:00:00Z", physical: 3 });
  const result = classifyStaleCart(c, false, NOW, 30);
  assert.deepEqual(result, { isStale: true, reason: "abandoned_stale" });
});

test("abandoned stale never returned for recent cart", () => {
  const c = cart({ updatedTime: "2026-07-01T00:00:00Z", physical: 3 });
  const result = classifyStaleCart(c, false, NOW, 30);
  assert.notEqual(result.reason, "abandoned_stale");
  assert.equal(result.isStale, false);
});

test("digital and gift cert items count toward total", () => {
  const c = cart({ updatedTime: "2026-05-01T00:00:00Z", physical: 0, digital: 1 });
  const result = classifyStaleCart(c, false, NOW, 30);
  assert.deepEqual(result, { isStale: true, reason: "abandoned_stale" });
});

test("custom stale days threshold is respected", () => {
  const c = cart({ updatedTime: "2026-07-05T00:00:00Z", physical: 0 });
  const result = classifyStaleCart(c, false, NOW, 3);
  assert.deepEqual(result, { isStale: true, reason: "empty_cart" });
});

test("exact threshold boundary is not stale", () => {
  const c = cart({ updatedTime: "2026-06-10T00:00:00Z", physical: 0 });
  const result = classifyStaleCart(c, false, NOW, 30);
  assert.equal(result.isStale, false);
});
