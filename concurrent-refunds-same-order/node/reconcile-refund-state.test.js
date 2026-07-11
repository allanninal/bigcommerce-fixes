import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileRefundState } from "./reconcile-refund-state.js";

const refundTxn = ({
  id = "1", amount = 25.0, gateway_transaction_id = "gw_1",
  date_created = "2026-07-01T10:00:00Z",
} = {}) => ({ id, amount, gateway_transaction_id, date_created });

test("ok when totals match and no duplicates", () => {
  const txns = [refundTxn({ id: "1", amount: 25.0, gateway_transaction_id: "gw_1" })];
  const result = reconcileRefundState(100.0, 25.0, txns);
  assert.equal(result.status, "ok");
  assert.equal(result.discrepancy, 0);
  assert.deepEqual(result.duplicateIds, []);
});

test("flag_duplicate when same gateway_transaction_id appears twice", () => {
  const txns = [
    refundTxn({ id: "1", amount: 25.0, gateway_transaction_id: "gw_1" }),
    refundTxn({ id: "2", amount: 25.0, gateway_transaction_id: "gw_1" }),
  ];
  const result = reconcileRefundState(100.0, 50.0, txns);
  assert.equal(result.status, "flag_duplicate");
  assert.deepEqual(result.duplicateIds.sort(), ["1", "2"]);
});

test("flag_duplicate when same amount and overlapping timestamp", () => {
  const txns = [
    refundTxn({ id: "1", amount: 25.0, gateway_transaction_id: "gw_1", date_created: "2026-07-01T10:00:00Z" }),
    refundTxn({ id: "2", amount: 25.0, gateway_transaction_id: "gw_2", date_created: "2026-07-01T10:00:00Z" }),
  ];
  const result = reconcileRefundState(100.0, 50.0, txns);
  assert.equal(result.status, "flag_duplicate");
  assert.deepEqual(result.duplicateIds.sort(), ["1", "2"]);
});

test("flag_mismatch when total_refunded does not match transaction sum", () => {
  const txns = [refundTxn({ id: "1", amount: 25.0, gateway_transaction_id: "gw_1" })];
  const result = reconcileRefundState(100.0, 40.0, txns);
  assert.equal(result.status, "flag_mismatch");
  assert.equal(result.discrepancy, 15.0);
});

test("ok when two distinct partial refunds sum correctly", () => {
  const txns = [
    refundTxn({ id: "1", amount: 20.0, gateway_transaction_id: "gw_1", date_created: "2026-07-01T09:00:00Z" }),
    refundTxn({ id: "2", amount: 30.0, gateway_transaction_id: "gw_2", date_created: "2026-07-01T11:00:00Z" }),
  ];
  const result = reconcileRefundState(100.0, 50.0, txns);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.duplicateIds, []);
});

test("flag_duplicate takes precedence over mismatch", () => {
  const txns = [
    refundTxn({ id: "1", amount: 25.0, gateway_transaction_id: "gw_1" }),
    refundTxn({ id: "2", amount: 25.0, gateway_transaction_id: "gw_1" }),
  ];
  const result = reconcileRefundState(100.0, 999.0, txns);
  assert.equal(result.status, "flag_duplicate");
});
