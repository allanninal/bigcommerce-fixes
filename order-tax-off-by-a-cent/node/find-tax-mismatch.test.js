import { test } from "node:test";
import assert from "node:assert/strict";
import { findTaxMismatch, toCents } from "./find-tax-mismatch.js";

const order = (totalTax = "10.00", id = 1, statusId = 9) => ({ id, total_tax: totalTax, status_id: statusId });
const taxRow = (amount, { name = "Automatic Tax", rate = "8.0000" } = {}) => ({ name, amount, rate });
const productRow = (priceTax, { quantity = 1, priceExTax = "50.00" } = {}) => ({
  price_tax: priceTax, quantity, price_ex_tax: priceExTax,
});

test("toCents rounds", () => {
  assert.equal(toCents("10.00"), 1000);
  assert.equal(toCents("9.99"), 999);
});

test("exact match returns null", () => {
  const result = findTaxMismatch(order("10.00"), [taxRow("10.00")], [productRow("10.00")]);
  assert.equal(result, null);
});

test("one cent within tolerance returns null", () => {
  const result = findTaxMismatch(order("10.00"), [taxRow("10.00")], [productRow("10.01")]);
  assert.equal(result, null);
});

test("two cent mismatch via products sum", () => {
  const result = findTaxMismatch(order("10.02"), [taxRow("10.02")], [productRow("10.00")]);
  assert.notEqual(result, null);
  assert.equal(result.mismatch, true);
  assert.equal(result.source, "products_sum");
  assert.equal(result.deltaCents, 2);
});

test("mismatch via taxes endpoint", () => {
  const result = findTaxMismatch(order("10.03"), [taxRow("10.00")], [productRow("10.03")]);
  assert.notEqual(result, null);
  assert.equal(result.source, "taxes_endpoint");
  assert.equal(result.deltaCents, 3);
});

test("multi quantity line rounding flags", () => {
  const result = findTaxMismatch(order("2.55"), [taxRow("2.52")], [productRow("2.55", { quantity: 3 })]);
  assert.notEqual(result, null);
  assert.equal(result.deltaCents, 3);
});

test("picks larger magnitude source", () => {
  const result = findTaxMismatch(order("10.05"), [taxRow("10.00")], [productRow("10.02")]);
  assert.equal(result.source, "taxes_endpoint");
  assert.equal(result.deltaCents, 5);
});

test("no taxes or products still mismatches against nonzero total", () => {
  const result = findTaxMismatch(order("5.00"), [], []);
  assert.notEqual(result, null);
  assert.equal(result.deltaCents, 500);
});
