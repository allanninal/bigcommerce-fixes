import { test } from "node:test";
import assert from "node:assert/strict";
import { findBlockedPriceListGroups } from "./clear-blocking-group-discounts.js";

const group = (id, name = "Wholesale", discountRules = []) => ({ id, name, discount_rules: discountRules });
const assignment = (customerGroupId, priceListId = 1, channelId = 1) => ({
  price_list_id: priceListId, customer_group_id: customerGroupId, channel_id: channelId,
});

test("group with rules and assignment is blocked", () => {
  const groups = [group(10, "Wholesale", [{ type: "product", method: "percent", amount: "10.000000" }])];
  const assignments = [assignment(10, 5)];
  const result = findBlockedPriceListGroups(groups, assignments);
  assert.deepEqual(result, [{
    group_id: 10,
    group_name: "Wholesale",
    discount_rules: [{ type: "product", method: "percent", amount: "10.000000" }],
    price_list_ids: [5],
  }]);
});

test("group with rules but no assignment is not blocked", () => {
  const groups = [group(11, "Wholesale", [{ type: "product", method: "percent", amount: "10.000000" }])];
  assert.deepEqual(findBlockedPriceListGroups(groups, []), []);
});

test("group with assignment but no rules is not blocked", () => {
  const groups = [group(12, "Wholesale", [])];
  const assignments = [assignment(12, 6)];
  assert.deepEqual(findBlockedPriceListGroups(groups, assignments), []);
});

test("group with neither is not blocked", () => {
  const groups = [group(13, "Wholesale", [])];
  assert.deepEqual(findBlockedPriceListGroups(groups, []), []);
});

test("multiple price lists on one blocked group are all collected", () => {
  const groups = [group(14, "Wholesale", [{ type: "storewide", method: "fixed", amount: "5.000000" }])];
  const assignments = [assignment(14, 7), assignment(14, 8)];
  const result = findBlockedPriceListGroups(groups, assignments);
  assert.deepEqual(result[0].price_list_ids, [7, 8]);
});

test("only matching group is flagged among several", () => {
  const groups = [
    group(15, "Wholesale", [{ type: "product", method: "percent", amount: "10.000000" }]),
    group(16, "Retail", []),
  ];
  const assignments = [assignment(15, 9), assignment(16, 9)];
  const result = findBlockedPriceListGroups(groups, assignments);
  assert.equal(result.length, 1);
  assert.equal(result[0].group_id, 15);
});
