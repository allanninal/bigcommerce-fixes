import { test } from "node:test";
import assert from "node:assert/strict";
import { isOrphanedRefundStatus } from "./find-orphaned-refund-statuses.js";

const refundTxn = ({ amount = "50.00", type = "refund" } = {}) => ({ type, amount });

test("false when status is not refund related", () => {
  assert.equal(isOrphanedRefundStatus(10, [], "0.00", "50.00"), false);
});

test("true when refunded status with no transactions at all", () => {
  assert.equal(isOrphanedRefundStatus(4, [], "0.00", "50.00"), true);
});

test("false when refunded status has a real refund transaction", () => {
  const txns = [refundTxn({ amount: "50.00" })];
  assert.equal(isOrphanedRefundStatus(4, txns, "50.00", "50.00"), false);
});

test("true when partially refunded with only non-refund transactions", () => {
  const txns = [{ type: "capture", amount: "50.00" }];
  assert.equal(isOrphanedRefundStatus(14, txns, "0.00", "50.00"), true);
});

test("false when refunded amount is recorded even without a txn row", () => {
  assert.equal(isOrphanedRefundStatus(4, [], "50.00", "50.00"), false);
});

test("true when refund transaction amount is zero", () => {
  const txns = [refundTxn({ amount: "0.00" })];
  assert.equal(isOrphanedRefundStatus(4, txns, "0.00", "50.00"), true);
});

test("uses event key when type key is absent", () => {
  const txns = [{ event: "refund", amount: "50.00" }];
  assert.equal(isOrphanedRefundStatus(4, txns, "50.00", "50.00"), false);
});

test("non-refund status id is never orphaned even with no transactions", () => {
  assert.equal(isOrphanedRefundStatus(7, [], "0.00", "50.00"), false);
});
