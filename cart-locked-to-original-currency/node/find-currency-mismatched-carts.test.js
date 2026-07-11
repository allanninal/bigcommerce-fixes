import { test } from "node:test";
import assert from "node:assert/strict";
import { findCurrencyMismatchedCarts } from "./find-currency-mismatched-carts.js";

const cart = ({ id = "cart_1", customerId = null, currency = "USD", physicalItems = [], isDraft = false } = {}) => ({
  id,
  customer_id: customerId,
  currency: { code: currency },
  line_items: { physical_items: physicalItems },
  base_amount: 50.0,
  is_draft: isDraft,
});

const item = (discounts = []) => ({ product_id: 1, variant_id: null, quantity: 1, discounts });

test("empty cart is never flagged", () => {
  const carts = [cart({ currency: "USD", physicalItems: [] })];
  const result = findCurrencyMismatchedCarts(carts, {}, "EUR");
  assert.deepEqual(result, []);
});

test("matching currency is not flagged", () => {
  const carts = [cart({ currency: "EUR", physicalItems: [item()] })];
  const result = findCurrencyMismatchedCarts(carts, {}, "EUR");
  assert.deepEqual(result, []);
});

test("mismatched currency is flagged with expected currency", () => {
  const carts = [cart({ id: "cart_9", customerId: 42, currency: "USD", physicalItems: [item()] })];
  const result = findCurrencyMismatchedCarts(carts, { "42": "EUR" }, "USD");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "cart_9");
  assert.equal(result[0].expected_currency, "EUR");
  assert.equal(result[0].has_blocking_discount, false);
});

test("guest cart falls back to store default currency", () => {
  const carts = [cart({ id: "cart_guest", customerId: null, currency: "USD", physicalItems: [item()] })];
  const result = findCurrencyMismatchedCarts(carts, {}, "GBP");
  assert.equal(result.length, 1);
  assert.equal(result[0].expected_currency, "GBP");
});

test("draft cart is flagged as blocking", () => {
  const carts = [cart({ id: "cart_draft", customerId: 7, currency: "USD", physicalItems: [item()], isDraft: true })];
  const result = findCurrencyMismatchedCarts(carts, { "7": "EUR" }, "USD");
  assert.equal(result.length, 1);
  assert.equal(result[0].has_blocking_discount, true);
});

test("cart with line item discount is flagged as blocking", () => {
  const carts = [cart({ id: "cart_disc", customerId: 3, currency: "USD", physicalItems: [item([{ id: 1 }])] })];
  const result = findCurrencyMismatchedCarts(carts, { "3": "EUR" }, "USD");
  assert.equal(result.length, 1);
  assert.equal(result[0].has_blocking_discount, true);
});

test("no action when expected currency cannot be resolved", () => {
  const carts = [cart({ id: "cart_unknown", customerId: null, currency: "USD", physicalItems: [item()] })];
  const result = findCurrencyMismatchedCarts(carts, {}, null);
  assert.deepEqual(result, []);
});
