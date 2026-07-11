import { test } from "node:test";
import assert from "node:assert/strict";
import { planCustomerMerge } from "./merge-duplicate-customers.js";

const makeAddress = ({ id = 1, address1 = "123 Main St", postal_code = "90210", city = "Beverly Hills" } = {}) => ({
  id, address1, postal_code, city,
});

test("reassigns every order regardless of status_id", () => {
  const canonical = { id: 1, addresses: [] };
  const duplicate = {
    id: 2,
    orders: [
      { id: 100, status_id: 10, total_inc_tax: "50.00" },
      { id: 101, status_id: 4, total_inc_tax: "20.00" },
      { id: 102, status_id: 5, total_inc_tax: "10.00" },
    ],
    addresses: [],
  };
  const plan = planCustomerMerge(canonical, duplicate);
  assert.deepEqual(plan.ordersToReassign, [100, 101, 102]);
});

test("skips duplicate address and creates new one", () => {
  const canonical = { id: 1, addresses: [makeAddress({ id: 9 })] };
  const duplicate = {
    id: 2,
    orders: [],
    addresses: [
      makeAddress({ id: 10, address1: "123 Main St", postal_code: "90210", city: "Beverly Hills" }),
      makeAddress({ id: 11, address1: "456 Oak Ave", postal_code: "10001", city: "New York" }),
    ],
  };
  const plan = planCustomerMerge(canonical, duplicate);
  assert.deepEqual(plan.addressesToSkip, [10]);
  assert.deepEqual(plan.addressesToCreate.map((a) => a.id), [11]);
});

test("address match is case insensitive", () => {
  const canonical = { id: 1, addresses: [makeAddress({ id: 9, address1: "123 MAIN ST", city: "BEVERLY HILLS" })] };
  const duplicate = { id: 2, orders: [], addresses: [makeAddress({ id: 10, address1: "123 main st", city: "beverly hills" })] };
  const plan = planCustomerMerge(canonical, duplicate);
  assert.deepEqual(plan.addressesToSkip, [10]);
  assert.deepEqual(plan.addressesToCreate, []);
});

test("duplicateCustomerIdToDeactivate is the duplicate", () => {
  const canonical = { id: 1, addresses: [] };
  const duplicate = { id: 2, orders: [], addresses: [] };
  const plan = planCustomerMerge(canonical, duplicate);
  assert.equal(plan.duplicateCustomerIdToDeactivate, 2);
});

test("throws when duplicate id equals canonical id", () => {
  const canonical = { id: 5, addresses: [] };
  const duplicate = { id: 5, orders: [], addresses: [] };
  assert.throws(() => planCustomerMerge(canonical, duplicate));
});

test("no addresses at all returns empty lists", () => {
  const canonical = { id: 1, addresses: [] };
  const duplicate = { id: 2, orders: [], addresses: [] };
  const plan = planCustomerMerge(canonical, duplicate);
  assert.deepEqual(plan.addressesToCreate, []);
  assert.deepEqual(plan.addressesToSkip, []);
});
