import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRefundStatus } from "./sync-gateway-refunds.js";

test("already reconciled is none", () => {
  const result = decideRefundStatus(100.00, 10, 0.00, 0.00);
  assert.equal(result.action, "none");
});

test("full refund not yet recorded sets status 4", () => {
  const result = decideRefundStatus(100.00, 10, 100.00, 0.00);
  assert.equal(result.action, "set_status");
  assert.equal(result.targetStatusId, 4);
});

test("partial refund not yet recorded sets status 14", () => {
  const result = decideRefundStatus(100.00, 11, 40.00, 0.00);
  assert.equal(result.action, "set_status");
  assert.equal(result.targetStatusId, 14);
});

test("already matches bc recorded amount is none", () => {
  const result = decideRefundStatus(100.00, 10, 40.00, 40.00);
  assert.equal(result.action, "none");
});

test("partial topped up to full moves to status 4", () => {
  // BigCommerce recorded a 40 partial refund already, gateway shows the full 100 refunded
  const result = decideRefundStatus(100.00, 14, 100.00, 40.00);
  assert.equal(result.action, "set_status");
  assert.equal(result.targetStatusId, 4);
});

test("order already at target status is none", () => {
  const result = decideRefundStatus(100.00, 4, 100.00, 0.00);
  assert.equal(result.action, "none");
});

test("order already at partial target status is none", () => {
  const result = decideRefundStatus(100.00, 14, 40.00, 0.00);
  assert.equal(result.action, "none");
});

test("negative gateway amount flags manual review", () => {
  const result = decideRefundStatus(100.00, 10, -5.00, 0.00);
  assert.equal(result.action, "flag_manual_review");
});

test("gateway amount exceeding total flags manual review", () => {
  const result = decideRefundStatus(100.00, 10, 150.00, 0.00);
  assert.equal(result.action, "flag_manual_review");
});

test("rounding tolerance treats near total as full refund", () => {
  // within a cent of the total should count as a full refund, not a partial
  const result = decideRefundStatus(100.00, 10, 99.995, 0.00);
  assert.equal(result.action, "set_status");
  assert.equal(result.targetStatusId, 4);
});

test("gateway less than or equal bc recorded after partial is none", () => {
  const result = decideRefundStatus(100.00, 14, 40.00, 60.00);
  assert.equal(result.action, "none");
});
