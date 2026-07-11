import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGroupConflict } from "./find-group-conflicts.js";

test("no conflict when both lists are empty", () => {
  const result = decideGroupConflict([], []);
  assert.equal(result.conflict, false);
});

test("no conflict when only group_ids is populated", () => {
  const result = decideGroupConflict([12, 14], []);
  assert.equal(result.conflict, false);
});

test("no conflict when only excluded_group_ids is populated", () => {
  const result = decideGroupConflict([], [9]);
  assert.equal(result.conflict, false);
});

test("conflict when both lists are populated", () => {
  const result = decideGroupConflict([12, 14], [9]);
  assert.equal(result.conflict, true);
  assert.equal(result.reason, "both group_ids and excluded_group_ids populated");
  assert.deepEqual(result.suggestedFix, { clear: "excluded_group_ids" });
});

test("conflict when guest sentinel zero is in group_ids", () => {
  const result = decideGroupConflict([0], [9]);
  assert.equal(result.conflict, true);
});

test("conflict when guest sentinel zero is in excluded_group_ids", () => {
  const result = decideGroupConflict([12], [0]);
  assert.equal(result.conflict, true);
});
