import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCustomerLookup } from "./reconcile-customer-id-filter.js";

test("v3 always ok even with id filter", () => {
  assert.equal(resolveCustomerLookup({ "id:in": "123" }, "v3", 200, null), "ok_list_filter");
});

test("v2 success is ok_list_filter", () => {
  assert.equal(resolveCustomerLookup({ email: "a@b.com" }, "v2", 200, null), "ok_list_filter");
});

test("v2 single id 400 falls back to direct resource", () => {
  assert.equal(resolveCustomerLookup({ id: "123" }, "v2", 400, "id"), "fallback_direct_resource");
});

test("v2 multiple ids 400 migrates to v3", () => {
  assert.equal(resolveCustomerLookup({ id: "123,124,125" }, "v2", 400, "id"), "migrate_to_v3");
});

test("v2 400 on unrelated field is ok_list_filter", () => {
  assert.equal(resolveCustomerLookup({ sort: "bogus" }, "v2", 400, "sort"), "ok_list_filter");
});

test("v2 400 with no error field is ok_list_filter", () => {
  assert.equal(resolveCustomerLookup({ id: "123" }, "v2", 400, null), "ok_list_filter");
});
