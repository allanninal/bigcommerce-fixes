import { test } from "node:test";
import assert from "node:assert/strict";
import { planCustomerMerge } from "./merge-duplicate-customers.js";

const customer = (id, email, date_created) => ({ id, email, date_created });
const order = (id, customer_id, billing_email) => ({ id, customer_id, billing_email });

test("no plan when all emails unique", () => {
  const customers = [customer(1, "a@example.com", "2026-01-01"), customer(2, "b@example.com", "2026-01-01")];
  assert.deepEqual(planCustomerMerge(customers, []), []);
});

test("survivor is earliest date_created", () => {
  const customers = [
    customer(2, "shopper@example.com", "2026-02-01"),
    customer(1, "shopper@example.com", "2026-01-01"),
  ];
  const plans = planCustomerMerge(customers, []);
  assert.deepEqual(plans, [{ survivorId: 1, reassignOrderIds: [], deleteCustomerIds: [2] }]);
});

test("tie break on lowest id when dates equal", () => {
  const customers = [
    customer(5, "shopper@example.com", "2026-01-01"),
    customer(2, "shopper@example.com", "2026-01-01"),
  ];
  const plans = planCustomerMerge(customers, []);
  assert.equal(plans[0].survivorId, 2);
  assert.deepEqual(plans[0].deleteCustomerIds, [5]);
});

test("matches email case and whitespace insensitive", () => {
  const customers = [
    customer(1, "Shopper@Example.com", "2026-01-01"),
    customer(2, "  shopper@example.com  ", "2026-01-02"),
  ];
  const plans = planCustomerMerge(customers, []);
  assert.deepEqual(plans, [{ survivorId: 1, reassignOrderIds: [], deleteCustomerIds: [2] }]);
});

test("single customer with a matching guest order produces no plan", () => {
  const customers = [customer(1, "shopper@example.com", "2026-01-01")];
  const orders = [order(100, 0, "shopper@example.com"), order(101, 0, "someone.else@example.com")];
  assert.deepEqual(planCustomerMerge(customers, orders), []);
});

test("reassigns losing customer and guest orders onto survivor", () => {
  const customers = [
    customer(1, "shopper@example.com", "2026-01-01"),
    customer(2, "shopper@example.com", "2026-01-05"),
  ];
  const orders = [
    order(100, 0, "shopper@example.com"),
    order(101, 2, "shopper@example.com"),
    order(102, 1, "shopper@example.com"),
    order(103, 9, "someone.else@example.com"),
  ];
  const plans = planCustomerMerge(customers, orders);
  assert.deepEqual(plans, [{ survivorId: 1, reassignOrderIds: [100, 101], deleteCustomerIds: [2] }]);
});

test("ignores customers without an email", () => {
  const customers = [customer(1, "", "2026-01-01"), customer(2, "", "2026-01-01")];
  assert.deepEqual(planCustomerMerge(customers, []), []);
});

test("never fuzzy matches similar but different emails", () => {
  const customers = [customer(1, "shopper@example.com", "2026-01-01"), customer(2, "shoppers@example.com", "2026-01-01")];
  assert.deepEqual(planCustomerMerge(customers, []), []);
});

test("three way cluster deletes both losers", () => {
  const customers = [
    customer(3, "shopper@example.com", "2026-03-01"),
    customer(1, "shopper@example.com", "2026-01-01"),
    customer(2, "shopper@example.com", "2026-02-01"),
  ];
  const orders = [order(500, 2, "shopper@example.com"), order(501, 3, "shopper@example.com")];
  const plans = planCustomerMerge(customers, orders);
  assert.deepEqual(plans, [{ survivorId: 1, reassignOrderIds: [500, 501], deleteCustomerIds: [2, 3] }]);
});
