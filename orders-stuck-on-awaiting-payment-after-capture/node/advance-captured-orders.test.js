import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOrderRepair } from "./advance-captured-orders.js";

const captureTxn = ({ amount = "50.00", type = "capture", status = "success" } = {}) => ({
  type, status, amount, gateway: "test_gateway", gateway_transaction_id: "gw_123", id: 1,
});

test("no_action when status is not awaiting payment", () => {
  assert.equal(decideOrderRepair(11, [captureTxn()], "50.00"), "no_action");
});

test("advance when successful capture matches total", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ amount: "50.00" })], "50.00"), "advance_to_awaiting_fulfillment");
});

test("advance when successful sale matches total", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ type: "sale", amount: "50.00" })], "50.00"), "advance_to_awaiting_fulfillment");
});

test("no_action when no capture-type transaction exists", () => {
  const txns = [{ type: "authorization", status: "success", amount: "50.00" }];
  assert.equal(decideOrderRepair(7, txns, "50.00"), "no_action");
});

test("no_action when transactions are empty", () => {
  assert.equal(decideOrderRepair(7, [], "50.00"), "no_action");
});

test("flag_for_review when capture is pending", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ status: "pending" })], "50.00"), "flag_for_review");
});

test("flag_for_review when capture is declined", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ status: "declined" })], "50.00"), "flag_for_review");
});

test("flag_for_review when amount does not match", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ amount: "40.00" })], "50.00"), "flag_for_review");
});

test("advance when one matching success sits alongside a declined one", () => {
  const txns = [captureTxn({ status: "declined", amount: "50.00" }), captureTxn({ status: "success", amount: "50.00" })];
  assert.equal(decideOrderRepair(7, txns, "50.00"), "advance_to_awaiting_fulfillment");
});

test("amount epsilon allows tiny float drift", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ amount: "50.004" })], "50.00"), "advance_to_awaiting_fulfillment");
});

test("amount epsilon rejects a real mismatch", () => {
  assert.equal(decideOrderRepair(7, [captureTxn({ amount: "50.50" })], "50.00"), "flag_for_review");
});
