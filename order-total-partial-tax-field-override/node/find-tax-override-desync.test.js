import { test } from "node:test";
import assert from "node:assert/strict";
import { findTaxOverrideDesync } from "./find-tax-override-desync.js";

const baseOrder = (overrides = {}) => ({
  id: 501,
  total_ex_tax: "100.00",
  total_inc_tax: "108.00",
  shipping_cost_inc_tax: "0.00",
  handling_cost_inc_tax: "0.00",
  discount_amount: "0.00",
  ...overrides,
});

const lineItem = (overrides = {}) => ({
  id: 9001,
  price_ex_tax: "100.00",
  price_inc_tax: "108.00",
  quantity: 1,
  total_ex_tax: "100.00",
  total_inc_tax: "108.00",
  ...overrides,
});

test("consistent order has no findings", () => {
  const findings = findTaxOverrideDesync(baseOrder(), [lineItem()]);
  assert.deepEqual(findings, []);
});

test("order-level partial override is flagged", () => {
  const order = baseOrder({ total_ex_tax: "0.00" });
  const findings = findTaxOverrideDesync(order, [lineItem()]);
  const orderFinding = findings.find((f) => f.scope === "order" && f.reason === "partial_override");
  assert.ok(orderFinding);
  assert.deepEqual(orderFinding.field_pair, ["total_ex_tax", "total_inc_tax"]);
  assert.equal(orderFinding.value_a, 0);
  assert.equal(orderFinding.value_b, 108);
});

test("line item partial override is flagged", () => {
  const items = [lineItem({ price_ex_tax: null })];
  const findings = findTaxOverrideDesync(baseOrder(), items);
  const lineFinding = findings.find((f) => f.scope === "line_item");
  assert.ok(lineFinding);
  assert.deepEqual(lineFinding.field_pair, ["price_ex_tax", "price_inc_tax"]);
});

test("total mismatch is flagged beyond epsilon", () => {
  const order = baseOrder({ total_inc_tax: "200.00" });
  const findings = findTaxOverrideDesync(order, [lineItem()]);
  const mismatch = findings.find((f) => f.reason === "total_mismatch");
  assert.ok(mismatch);
  assert.equal(mismatch.value_b, 200);
});

test("rounding within epsilon is not flagged", () => {
  const order = baseOrder({ total_inc_tax: "108.005" });
  const findings = findTaxOverrideDesync(order, [lineItem()], 0.01);
  assert.ok(findings.every((f) => f.reason !== "total_mismatch"));
});

test("no findings when both sides of a pair are zero", () => {
  const order = baseOrder({ total_ex_tax: "0.00", total_inc_tax: "0.00" });
  const items = [lineItem({ price_ex_tax: "0.00", price_inc_tax: "0.00", total_ex_tax: "0.00", total_inc_tax: "0.00" })];
  const findings = findTaxOverrideDesync(order, items);
  assert.ok(findings.every((f) => f.reason !== "partial_override"));
});

test("shipping and discount are included in reconciliation", () => {
  const order = baseOrder({ total_inc_tax: "118.00", shipping_cost_inc_tax: "20.00", discount_amount: "10.00" });
  const findings = findTaxOverrideDesync(order, [lineItem()]);
  assert.ok(findings.every((f) => f.reason !== "total_mismatch"));
});
