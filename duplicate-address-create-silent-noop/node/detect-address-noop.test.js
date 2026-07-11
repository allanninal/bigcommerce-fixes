import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAddressCreateResult, findMatchedAddressId } from "./detect-address-noop.js";

const snapshot = (ids, total) => {
  const idSet = new Set(ids);
  return { ids: idSet, total: total !== undefined ? total : idSet.size };
};

test("created when a new id appears", () => {
  const pre = snapshot([1, 2]);
  const post = snapshot([1, 2, 3]);
  const response = { status: 201, data: { id: 3 } };
  assert.equal(classifyAddressCreateResult(pre, response, post), "created");
});

test("silent_noop when total and ids unchanged and no id in data", () => {
  const pre = snapshot([1, 2]);
  const post = snapshot([1, 2]);
  const response = { status: 200, data: [] };
  assert.equal(classifyAddressCreateResult(pre, response, post), "silent_noop");
});

test("silent_noop when data is empty object", () => {
  const pre = snapshot([1, 2]);
  const post = snapshot([1, 2]);
  const response = { status: 207, data: {} };
  assert.equal(classifyAddressCreateResult(pre, response, post), "silent_noop");
});

test("error on 4xx status", () => {
  const pre = snapshot([1, 2]);
  const post = snapshot([1, 2]);
  const response = { status: 422, data: {} };
  assert.equal(classifyAddressCreateResult(pre, response, post), "error");
});

test("error on 5xx status", () => {
  const pre = snapshot([1, 2]);
  const post = snapshot([1, 2]);
  const response = { status: 500, data: null };
  assert.equal(classifyAddressCreateResult(pre, response, post), "error");
});

test("created when data has id even if totals look equal", () => {
  const pre = snapshot([1, 2]);
  const post = snapshot([1, 2, 3]);
  const response = { status: 200, data: [{ id: 3 }] };
  assert.equal(classifyAddressCreateResult(pre, response, post), "created");
});

test("findMatchedAddressId returns the matching existing record", () => {
  const existing = [
    { id: 55, first_name: "Jamie", last_name: "Rivera", company: "", phone: "",
      address_type: "residential", address1: "123 Main St", address2: "", city: "Austin",
      country_code: "US", state_or_province: "Texas", postal_code: "78701" },
  ];
  const attempted = {
    first_name: "Jamie", last_name: "Rivera", company: "", phone: "",
    address_type: "residential", address1: "123 Main St", address2: "",
    city: "Austin", country_code: "US", state_or_province: "Texas", postal_code: "78701",
  };
  assert.equal(findMatchedAddressId(existing, attempted), 55);
});

test("findMatchedAddressId returns null when no match", () => {
  const existing = [
    { id: 55, first_name: "Jamie", last_name: "Rivera", address1: "123 Main St",
      city: "Austin", country_code: "US", state_or_province: "Texas", postal_code: "78701" },
  ];
  const attempted = {
    first_name: "Alex", last_name: "Nguyen", address1: "9 Other Ave",
    city: "Dallas", country_code: "US", state_or_province: "Texas", postal_code: "75001",
  };
  assert.equal(findMatchedAddressId(existing, attempted), null);
});
