import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOrderTransactions, toCents } from "./find-transactions-mismatch.js";

const order = (totalIncTax = "100.00", refundedAmount = "0.00") => ({ totalIncTax, refundedAmount });
const txn = (amount, { type = "purchase", success = true } = {}) => ({ type, amount, success });

test("toCents rounds", () => {
  assert.equal(toCents("50.00"), 5000);
  assert.equal(toCents("9.99"), 999);
});

test("exact match is not mismatched", () => {
  const result = reconcileOrderTransactions(order("100.00", "0.00"), [txn("100.00")]);
  assert.equal(result.isMismatched, false);
  assert.equal(result.diffCents, 0);
});

test("over refund is mismatched", () => {
  const result = reconcileOrderTransactions(order("100.00", "60.00"), [txn("100.00")]);
  assert.equal(result.isMismatched, true);
  assert.equal(result.diffCents, 6000);
});

test("missing refund transaction is mismatched", () => {
  const result = reconcileOrderTransactions(order("100.00", "20.00"), [txn("100.00")]);
  assert.equal(result.isMismatched, true);
  assert.equal(result.diffCents, 2000);
});

test("matching refund transaction ties out", () => {
  const result = reconcileOrderTransactions(order("100.00", "20.00"), [
    txn("100.00"),
    txn("20.00", { type: "refund" }),
  ]);
  assert.equal(result.isMismatched, false);
});

test("failed transaction ignored", () => {
  const result = reconcileOrderTransactions(order("100.00", "0.00"), [
    txn("100.00"),
    txn("50.00", { type: "refund", success: false }),
  ]);
  assert.equal(result.isMismatched, false);
});

test("rounding at the epsilon boundary", () => {
  const resultAt = reconcileOrderTransactions(order("100.00", "0.00"), [txn("100.01")], 1);
  assert.equal(resultAt.isMismatched, false);
  const resultOver = reconcileOrderTransactions(order("100.00", "0.00"), [txn("100.02")], 1);
  assert.equal(resultOver.isMismatched, true);
});
