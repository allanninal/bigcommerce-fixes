import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTestOrder } from "./flag-test-orders.js";

const order = (over = {}) => ({
  status_id: 10,
  customer_id: 42,
  total_inc_tax: "89.00",
  billing_address: { email: "shopper@realcustomer.com" },
  ...over,
});

const txn = (over = {}) => ({ test: false, gateway: "Authorize.net", ...over });

test("not a test order for an ordinary paid order", () => {
  const result = classifyTestOrder(order(), [txn()]);
  assert.equal(result.isTest, false);
  assert.deepEqual(result.reasons, []);
});

test("flagged when transaction test flag is true", () => {
  const result = classifyTestOrder(order(), [txn({ test: true })]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("test_gateway_transaction"));
});

test("flagged when gateway name is Test Payment Gateway", () => {
  const result = classifyTestOrder(order(), [txn({ gateway: "Test Payment Gateway" })]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("test_gateway_name"));
});

test("flagged when billing email matches a test pattern", () => {
  const o = order({ billing_address: { email: "qa-checkout@company.com" } });
  const result = classifyTestOrder(o, [txn()]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("test_email_pattern"));
});

test("flagged when guest checkout carries a nominal total", () => {
  const o = order({ customer_id: 0, total_inc_tax: "0.50" });
  const result = classifyTestOrder(o, [txn()]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("nominal_staff_test_amount"));
});

test("guest checkout with a real total is not flagged alone", () => {
  const o = order({ customer_id: 0, total_inc_tax: "89.00" });
  const result = classifyTestOrder(o, [txn()]);
  assert.equal(result.isTest, false);
});

test("non revenue status alone does not mark as test", () => {
  const o = order({ status_id: 5 }); // Cancelled
  const result = classifyTestOrder(o, [txn()]);
  assert.equal(result.isTest, false);
  assert.ok(result.reasons.includes("non_revenue_status"));
});

test("non revenue status combined with a test signal still flags", () => {
  const o = order({ status_id: 0 }); // Incomplete
  const result = classifyTestOrder(o, [txn({ test: true })]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("non_revenue_status"));
  assert.ok(result.reasons.includes("test_gateway_transaction"));
});

test("email pattern match is case insensitive", () => {
  const o = order({ billing_address: { email: "QA-Lead@Company.com" } });
  const result = classifyTestOrder(o, [txn()]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("test_email_pattern"));
});

test("missing billing address does not throw", () => {
  const o = order({ billing_address: null });
  const result = classifyTestOrder(o, [txn()]);
  assert.equal(result.isTest, false);
});

test("multiple reasons are all collected", () => {
  const o = order({
    customer_id: 0,
    total_inc_tax: "0.01",
    billing_address: { email: "test@test.com" },
  });
  const result = classifyTestOrder(o, [txn({ test: true, gateway: "Test Payment Gateway" })]);
  assert.equal(result.isTest, true);
  assert.deepEqual(
    new Set(result.reasons),
    new Set(["test_gateway_transaction", "test_gateway_name", "test_email_pattern", "nominal_staff_test_amount"])
  );
});

test("custom email patterns are respected", () => {
  const o = order({ billing_address: { email: "staging@internal-corp.com" } });
  const result = classifyTestOrder(o, [txn()], [/@internal-corp\.com$/]);
  assert.equal(result.isTest, true);
  assert.ok(result.reasons.includes("test_email_pattern"));
});
