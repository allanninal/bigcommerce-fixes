import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRestock } from "./restock-declined-orders.js";

const order = (over = {}) => ({
  status_id: 6,
  already_adjusted: false,
  products: [{ variant_id: 101, sku: "ABC-1", quantity: 2 }],
  ...over,
});

test("restocks Declined order with no charge", () => {
  const result = decideRestock(order(), []);
  assert.equal(result.action, "restock");
  assert.deepEqual(result.items, [{ variant_id: 101, qty: 2 }]);
});

test("restocks multiple line items", () => {
  const products = [
    { variant_id: 101, sku: "ABC-1", quantity: 2 },
    { variant_id: 202, sku: "ABC-2", quantity: 1 },
  ];
  const result = decideRestock(order({ products }), []);
  assert.equal(result.action, "restock");
  assert.deepEqual(result.items, [
    { variant_id: 101, qty: 2 },
    { variant_id: 202, qty: 1 },
  ]);
});

test("skips non Declined order", () => {
  for (const status_id of [0, 1, 4, 5, 10, 11]) {
    assert.deepEqual(decideRestock(order({ status_id }), []), { action: "skip", items: [] });
  }
});

test("skips already adjusted order", () => {
  assert.deepEqual(decideRestock(order({ already_adjusted: true }), []), { action: "skip", items: [] });
});

test("already adjusted wins over transactions", () => {
  const result = decideRestock(order({ already_adjusted: true }), [{ status: "approved" }]);
  assert.deepEqual(result, { action: "skip", items: [] });
});

test("flags when transaction was approved", () => {
  assert.deepEqual(decideRestock(order(), [{ status: "approved" }]), { action: "flag", items: [] });
});

test("flags when transaction was captured", () => {
  assert.deepEqual(decideRestock(order(), [{ status: "captured" }]), { action: "flag", items: [] });
});

test("flags when one of several transactions is captured", () => {
  const txns = [{ status: "declined" }, { status: "voided" }, { status: "captured" }];
  assert.deepEqual(decideRestock(order(), txns), { action: "flag", items: [] });
});

test("ignores declined transactions", () => {
  assert.equal(decideRestock(order(), [{ status: "declined" }]).action, "restock");
});

test("no transactions restocks", () => {
  assert.equal(decideRestock(order(), []).action, "restock");
});
