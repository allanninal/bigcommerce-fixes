import { test } from "node:test";
import assert from "node:assert/strict";
import { findConsignmentDrift } from "./find-consignment-drift.js";

const consignment = (itemId, quantity, addressId = "addr_1") => ({
  consignment_id: `c_${addressId}`,
  address_id: addressId,
  line_items: [{ item_id: itemId, quantity }],
});

const productRow = (productId, quantity, orderAddressId, rowId = 1) => ({
  id: rowId, product_id: productId, quantity, order_address_id: orderAddressId,
});

test("ok when every item assigned once and quantities match", () => {
  const consignments = [consignment(101, 2, "addr_1"), consignment(102, 1, "addr_2")];
  const products = [productRow(101, 2, 10, 1), productRow(102, 1, 11, 2)];
  const drift = findConsignmentDrift(consignments, products);
  assert.ok(drift.every((d) => d.status === "ok"));
});

test("unassigned when order_address_id is zero", () => {
  const consignments = [consignment(101, 3, "addr_1")];
  const products = [productRow(101, 3, 0, 1)];
  const drift = findConsignmentDrift(consignments, products);
  const record = drift.find((d) => d.product_id === 101);
  assert.equal(record.status, "unassigned");
  assert.equal(record.unassigned_qty, 3);
});

test("unassigned when order_address_id is null", () => {
  const consignments = [consignment(101, 1, "addr_1")];
  const products = [productRow(101, 1, null, 1)];
  const drift = findConsignmentDrift(consignments, products);
  const record = drift.find((d) => d.product_id === 101);
  assert.equal(record.status, "unassigned");
});

test("duplicated when actual quantity exceeds expected", () => {
  const consignments = [consignment(101, 1, "addr_1")];
  const products = [productRow(101, 1, 10, 1), productRow(101, 1, 11, 2)];
  const drift = findConsignmentDrift(consignments, products);
  const record = drift.find((d) => d.product_id === 101);
  assert.equal(record.status, "duplicated");
  assert.equal(record.expected_qty, 1);
  assert.equal(record.actual_qty, 2);
  assert.equal(record.duplicated_qty, 1);
});

test("ok when no consignments and no products", () => {
  assert.deepEqual(findConsignmentDrift([], []), []);
});

test("ok when two addresses each have distinct items and quantities match", () => {
  const consignments = [
    consignment(201, 4, "addr_1"),
    consignment(202, 2, "addr_2"),
    consignment(203, 1, "addr_3"),
  ];
  const products = [
    productRow(201, 4, 20, 1),
    productRow(202, 2, 21, 2),
    productRow(203, 1, 22, 3),
  ];
  const drift = findConsignmentDrift(consignments, products);
  assert.ok(drift.every((d) => d.status === "ok"));
  assert.equal(drift.length, 3);
});

test("multiple product ids reported independently", () => {
  const consignments = [consignment(301, 1, "addr_1"), consignment(302, 1, "addr_2")];
  const products = [
    productRow(301, 1, 0, 1), // unassigned
    productRow(302, 1, 31, 2), // ok
  ];
  const drift = findConsignmentDrift(consignments, products);
  const byId = Object.fromEntries(drift.map((d) => [d.product_id, d]));
  assert.equal(byId[301].status, "unassigned");
  assert.equal(byId[302].status, "ok");
});
