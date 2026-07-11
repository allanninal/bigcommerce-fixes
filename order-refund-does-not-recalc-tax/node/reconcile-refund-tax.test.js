import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOrderTax } from "./reconcile-refund-tax.js";

const baseOrder = (overrides = {}) => ({
  id: 701, total_tax: "8.00", total_ex_tax: "100.00", total_inc_tax: "108.00", ...overrides,
});

const lineItemRefund = ({ amount = "50.00", tax_amount = "4.00" } = {}) => ({
  id: 1, type: "refund", item_type: "PRODUCT", amount, tax_amount,
});

const orderLevelRefund = ({ amount = "10.00", tax_amount = null } = {}) => ({
  id: 2, type: "refund", item_type: "ORDER", amount, tax_amount,
});

test("reconciled when line item refund tax matches", () => {
  const order = baseOrder({ total_tax: "4.00" });
  const record = reconcileOrderTax(order, [lineItemRefund({ tax_amount: "4.00" })]);
  assert.equal(record.flagged, false);
  assert.equal(record.reason, null);
  assert.equal(record.expected_total_tax, 4);
});

test("flagged when order-level refund has zero tax", () => {
  const order = baseOrder({ total_tax: "8.00" });
  const record = reconcileOrderTax(order, [orderLevelRefund()]);
  assert.equal(record.flagged, true);
  assert.equal(record.reason, "order-level refund skipped tax recalculation");
});

test("flagged when total_tax drift exceeds tolerance", () => {
  // A non-refund transaction (a chargeback) carries its own tax_amount, which
  // feeds originalTax but is not backed out of expectedTotalTax the way a
  // refund-type transaction is. That mismatch is a genuine total_tax drift,
  // independent of the order-level-zero-tax signature.
  const order = baseOrder({ total_tax: "8.00" });
  const txns = [
    lineItemRefund({ amount: "50.00", tax_amount: "4.00" }),
    { id: 3, type: "chargeback", item_type: "PRODUCT", amount: "40.00", tax_amount: "3.00" },
  ];
  const record = reconcileOrderTax(order, txns);
  assert.equal(record.flagged, true);
  assert.equal(record.reason, "total_tax drift");
  assert.equal(record.delta, 3);
});

test("not flagged when delta within tolerance", () => {
  const order = baseOrder({ total_tax: "4.001" });
  const record = reconcileOrderTax(order, [lineItemRefund({ tax_amount: "4.00" })], 0.01);
  assert.equal(record.flagged, false);
});

test("order id and stored total tax pass through", () => {
  const order = baseOrder({ total_tax: "8.00" });
  const record = reconcileOrderTax(order, [lineItemRefund({ tax_amount: "4.00" })]);
  assert.equal(record.order_id, 701);
  assert.equal(record.stored_total_tax, 8);
});

test("multiple refund line items are summed correctly", () => {
  const order = baseOrder({ total_tax: "0.00" });
  const txns = [
    lineItemRefund({ amount: "30.00", tax_amount: "2.40" }),
    lineItemRefund({ amount: "20.00", tax_amount: "1.60" }),
  ];
  const record = reconcileOrderTax(order, txns);
  assert.equal(record.expected_total_tax, 0);
  assert.equal(record.flagged, false);
});

test("single line item refund with no drift is not flagged", () => {
  const order = baseOrder({ total_tax: "4.00" });
  const txns = [lineItemRefund({ tax_amount: "4.00" })];
  const record = reconcileOrderTax(order, txns);
  assert.equal(record.expected_total_tax, 4);
  assert.equal(record.flagged, false);
});
