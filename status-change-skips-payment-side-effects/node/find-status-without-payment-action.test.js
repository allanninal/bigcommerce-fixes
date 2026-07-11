import { test } from "node:test";
import assert from "node:assert/strict";
import { findStatusWithoutPaymentAction } from "./find-status-without-payment-action.js";

const makeOrder = (statusId, paymentStatus = "captured") => ({
  id: 101, status_id: statusId, payment_status: paymentStatus,
});

const txn = (type, status = "ok") => ({ type, status });

test("refunded order with ok refund is consistent", () => {
  assert.equal(
    findStatusWithoutPaymentAction(makeOrder(4), [txn("auth"), txn("capture"), txn("refund")]),
    null
  );
});

test("refunded order with no refund transaction is flagged", () => {
  assert.equal(
    findStatusWithoutPaymentAction(makeOrder(4), [txn("auth"), txn("capture")]),
    "MISSING_REFUND"
  );
});

test("partially refunded order with no refund transaction is flagged", () => {
  assert.equal(
    findStatusWithoutPaymentAction(makeOrder(14), [txn("auth"), txn("capture")]),
    "MISSING_REFUND"
  );
});

test("cancelled order authorize only with no void is flagged", () => {
  assert.equal(findStatusWithoutPaymentAction(makeOrder(5), [txn("auth")]), "MISSING_VOID");
});

test("cancelled order authorize only with void is consistent", () => {
  assert.equal(
    findStatusWithoutPaymentAction(makeOrder(5), [txn("auth"), txn("void")]),
    null
  );
});

test("cancelled order with no transactions at all needs no void", () => {
  assert.equal(findStatusWithoutPaymentAction(makeOrder(5), []), null);
});

test("cancelled order authorized and captured is not a void case", () => {
  assert.equal(
    findStatusWithoutPaymentAction(makeOrder(5), [txn("auth"), txn("capture")]),
    null
  );
});

test("shipped order authorize only never captured is flagged", () => {
  assert.equal(findStatusWithoutPaymentAction(makeOrder(2), [txn("auth")]), "MISSING_CAPTURE");
});

test("completed order with ok capture is consistent", () => {
  assert.equal(
    findStatusWithoutPaymentAction(makeOrder(10), [txn("auth"), txn("capture")]),
    null
  );
});

test("awaiting fulfillment order with purchase transaction is consistent", () => {
  assert.equal(findStatusWithoutPaymentAction(makeOrder(11), [txn("purchase")]), null);
});

test("pending or declined transactions do not count as the side effect", () => {
  const txns = [txn("auth"), txn("refund", "pending")];
  assert.equal(findStatusWithoutPaymentAction(makeOrder(4), txns), "MISSING_REFUND");
});

test("status_id with no implication is always consistent", () => {
  assert.equal(findStatusWithoutPaymentAction(makeOrder(1), []), null);
});
