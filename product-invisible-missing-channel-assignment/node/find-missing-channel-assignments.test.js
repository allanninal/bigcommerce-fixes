import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingChannelAssignments } from "./find-missing-channel-assignments.js";

test("no gaps when every visible product is assigned", () => {
  const catalogIds = new Set([1, 2]);
  const visibleIds = new Set([1, 2]);
  const assignments = { 10: new Set([1, 2]), 11: new Set([1, 2]) };
  assert.deepEqual(findMissingChannelAssignments(catalogIds, assignments, visibleIds), []);
});

test("flags visible product missing from one channel", () => {
  const catalogIds = new Set([1, 2]);
  const visibleIds = new Set([1, 2]);
  const assignments = { 10: new Set([1, 2]), 11: new Set([1]) };
  assert.deepEqual(findMissingChannelAssignments(catalogIds, assignments, visibleIds), [[2, 11]]);
});

test("ignores invisible products even if missing everywhere", () => {
  const catalogIds = new Set([1, 2, 3]);
  const visibleIds = new Set([1, 2]);
  const assignments = { 10: new Set([1, 2]) };
  assert.deepEqual(findMissingChannelAssignments(catalogIds, assignments, visibleIds), []);
});

test("flags across multiple channels and sorts the result", () => {
  const catalogIds = new Set([1, 2]);
  const visibleIds = new Set([1, 2]);
  const assignments = { 20: new Set(), 10: new Set([1]) };
  assert.deepEqual(findMissingChannelAssignments(catalogIds, assignments, visibleIds), [
    [1, 20], [2, 10], [2, 20],
  ]);
});

test("no channels means no gaps", () => {
  const catalogIds = new Set([1, 2]);
  const visibleIds = new Set([1, 2]);
  assert.deepEqual(findMissingChannelAssignments(catalogIds, {}, visibleIds), []);
});
