import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShippingAddressGap } from "./flag-missing-shipping-addresses.js";

test("digital-only order with no address is ok", () => {
  assert.equal(classifyShippingAddressGap(11, ["digital"], false), "ok_digital_only");
});

test("mixed cart with no address is ok_digital_only when no physical present", () => {
  assert.equal(classifyShippingAddressGap(11, ["digital", "digital"], false), "ok_digital_only");
});

test("order with address is ok regardless of line items", () => {
  assert.equal(classifyShippingAddressGap(11, ["digital"], true), "ok_has_address");
  assert.equal(classifyShippingAddressGap(11, ["physical"], true), "ok_has_address");
});

test("excluded status is inconclusive even with physical item", () => {
  assert.equal(classifyShippingAddressGap(0, ["physical"], false), "ok_excluded_status");
  assert.equal(classifyShippingAddressGap(5, ["physical"], false), "ok_excluded_status");
  assert.equal(classifyShippingAddressGap(6, ["physical"], false), "ok_excluded_status");
});

test("physical item with no address on real status is anomaly", () => {
  assert.equal(classifyShippingAddressGap(11, ["physical"], false), "anomaly_missing_address");
});

test("mixed cart with physical item and no address is anomaly", () => {
  assert.equal(classifyShippingAddressGap(9, ["digital", "physical"], false), "anomaly_missing_address");
});

test("excluded status wins over missing address check", () => {
  assert.equal(classifyShippingAddressGap(0, [], false), "ok_excluded_status");
});

test("no line items and no address is ok_digital_only", () => {
  assert.equal(classifyShippingAddressGap(11, [], false), "ok_digital_only");
});

test("all real post-checkout statuses flag physical with no address", () => {
  for (const statusId of [1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14]) {
    assert.equal(classifyShippingAddressGap(statusId, ["physical"], false), "anomaly_missing_address");
  }
});
