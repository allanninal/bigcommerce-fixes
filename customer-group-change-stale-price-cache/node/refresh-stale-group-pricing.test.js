import { test } from "node:test";
import assert from "node:assert/strict";
import { isPriceStale } from "./refresh-stale-group-pricing.js";

const cartItem = ({ listPrice = "50.00", salePrice = null } = {}) => ({
  list_price: listPrice, sale_price: salePrice,
});

const priceRecord = ({ price = "50.00", salePrice = null } = {}) => ({
  price, sale_price: salePrice,
});

test("matching prices are not stale", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "42.00" }), priceRecord({ price: "42.00" })), false);
});

test("stale when cart price is higher than current list", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "55.00" }), priceRecord({ price: "42.00" })), true);
});

test("stale when cart price is lower than current list", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "30.00" }), priceRecord({ price: "42.00" })), true);
});

test("prefers sale_price on the price list record", () => {
  const record = priceRecord({ price: "42.00", salePrice: "35.00" });
  assert.equal(isPriceStale(cartItem({ listPrice: "35.00" }), record), false);
  assert.equal(isPriceStale(cartItem({ listPrice: "42.00" }), record), true);
});

test("prefers sale_price on the cart line item", () => {
  const item = cartItem({ listPrice: "42.00", salePrice: "35.00" });
  assert.equal(isPriceStale(item, priceRecord({ price: "42.00" })), true);
  assert.equal(isPriceStale(item, priceRecord({ price: "35.00" })), false);
});

test("decimal precision edge case within tolerance", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "19.999" }), priceRecord({ price: "20.00" })), false);
});

test("decimal precision edge case outside tolerance", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "19.90" }), priceRecord({ price: "20.00" })), true);
});

test("both sides missing sale_price uses list and price", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "10.00", salePrice: null }), priceRecord({ price: "10.00", salePrice: null })), false);
});

test("custom tolerance is respected", () => {
  assert.equal(isPriceStale(cartItem({ listPrice: "10.05" }), priceRecord({ price: "10.00" }), 0.10), false);
  assert.equal(isPriceStale(cartItem({ listPrice: "10.15" }), priceRecord({ price: "10.00" }), 0.10), true);
});
