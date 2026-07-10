import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDisputeFlag } from "./flag-disputed-orders.js";

const chargebackTxn = ({ type = "chargeback", status = "pending" } = {}) => ({
  type, status, amount: "50.00", id: 1,
});

test("flags when transaction type is chargeback", () => {
  assert.equal(needsDisputeFlag(10, [chargebackTxn()]), true);
});

test("flags when transaction status reads disputed", () => {
  const txn = { type: "capture", status: "disputed", amount: "50.00", id: 2 };
  assert.equal(needsDisputeFlag(10, [txn]), true);
});

test("no flag when no dispute marker present", () => {
  const txn = { type: "capture", status: "success", amount: "50.00", id: 3 };
  assert.equal(needsDisputeFlag(10, [txn]), false);
});

test("no flag when already disputed", () => {
  assert.equal(needsDisputeFlag(13, [chargebackTxn()]), false);
});

test("no flag when already refunded", () => {
  assert.equal(needsDisputeFlag(4, [chargebackTxn()]), false);
});

test("no flag when already cancelled", () => {
  assert.equal(needsDisputeFlag(5, [chargebackTxn()]), false);
});

test("no flag with no transactions", () => {
  assert.equal(needsDisputeFlag(10, []), false);
});
