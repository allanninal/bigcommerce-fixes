import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOrderRepair } from "./reconcile-incomplete-orders.js";

const txn = ({ type = "purchase", status = "success", gateway_transaction_id = "gw_123" } = {}) => ({
  type,
  status,
  gateway_transaction_id,
});

test("no action when status is not incomplete", () => {
  assert.equal(decideOrderRepair(11, [txn()]), "no_action");
});

test("no action when no charge transactions", () => {
  assert.equal(decideOrderRepair(0, []), "no_action");
  assert.equal(decideOrderRepair(0, [txn({ type: "void" })]), "no_action");
});

test("no action when only pending or declined", () => {
  const pending = txn({ status: "pending", gateway_transaction_id: null });
  const declined = txn({ status: "declined" });
  assert.equal(decideOrderRepair(0, [pending]), "no_action");
  assert.equal(decideOrderRepair(0, [declined]), "no_action");
});

test("advance when successful capture with no conflict", () => {
  assert.equal(decideOrderRepair(0, [txn()]), "advance_to_awaiting_fulfillment");
  assert.equal(decideOrderRepair(0, [txn({ type: "capture" })]), "advance_to_awaiting_fulfillment");
});

test("advance ignores unrelated transaction types", () => {
  const success = txn();
  const other = { type: "refund", status: "success", gateway_transaction_id: "gw_999" };
  assert.equal(decideOrderRepair(0, [success, other]), "advance_to_awaiting_fulfillment");
});

test("flag for review when success conflicts with void", () => {
  const success = txn();
  const voidTxn = txn({ type: "void", status: "success", gateway_transaction_id: "gw_456" });
  assert.equal(decideOrderRepair(0, [success, voidTxn]), "flag_for_review");
});

test("flag for review when success conflicts with declined", () => {
  const success = txn();
  const declined = txn({ status: "declined" });
  assert.equal(decideOrderRepair(0, [success, declined]), "flag_for_review");
});

test("no action when success missing gateway transaction id", () => {
  const incompleteSuccess = txn({ gateway_transaction_id: null });
  assert.equal(decideOrderRepair(0, [incompleteSuccess]), "no_action");
});

test("advance when approved status used instead of success", () => {
  assert.equal(decideOrderRepair(0, [txn({ status: "approved" })]), "advance_to_awaiting_fulfillment");
});
