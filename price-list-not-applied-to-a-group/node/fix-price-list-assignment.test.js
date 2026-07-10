import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReassignment } from "./fix-price-list-assignment.js";

const GROUP = { id: 7, name: "Wholesale" };
const PRICE_LIST = { id: 42, active: true };
const CHANNELS = [1, 2];

test("create assignment when none exists", () => {
  const decision = decideReassignment(GROUP, PRICE_LIST, [], CHANNELS, [], []);
  assert.deepEqual(decision, {
    action: "CREATE_ASSIGNMENT",
    priceListId: 42,
    customerGroupId: 7,
    channelId: 1,
  });
});

test("fix channel when assignment on wrong channel", () => {
  const assignments = [{ id: 900, price_list_id: 42, customer_group_id: 7, channel_id: 99 }];
  const decision = decideReassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [], []);
  assert.deepEqual(decision, {
    action: "FIX_CHANNEL",
    assignmentId: 900,
    fromChannelId: 99,
    toChannelId: 1,
  });
});

test("flag missing records when assignment correct but sparse", () => {
  const assignments = [{ id: 901, price_list_id: 42, customer_group_id: 7, channel_id: 1 }];
  const decision = decideReassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [501, 502], [501]);
  assert.deepEqual(decision, { action: "FLAG_MISSING_RECORDS", priceListId: 42, missingVariantIds: [502] });
});

test("none when fully healthy", () => {
  const assignments = [{ id: 902, price_list_id: 42, customer_group_id: 7, channel_id: 1 }];
  const decision = decideReassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [501, 502], [501, 502]);
  assert.deepEqual(decision, { action: "NONE" });
});

test("none when no active price list", () => {
  assert.deepEqual(decideReassignment(GROUP, null, [], CHANNELS, [], []), { action: "NONE" });
  assert.deepEqual(
    decideReassignment(GROUP, { id: 42, active: false }, [], CHANNELS, [], []),
    { action: "NONE" }
  );
});

test("multiple group assignments ignores other groups", () => {
  const assignments = [
    { id: 800, price_list_id: 42, customer_group_id: 99, channel_id: 1 },
    { id: 901, price_list_id: 42, customer_group_id: 7, channel_id: 1 },
  ];
  const decision = decideReassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [], []);
  assert.deepEqual(decision, { action: "NONE" });
});
