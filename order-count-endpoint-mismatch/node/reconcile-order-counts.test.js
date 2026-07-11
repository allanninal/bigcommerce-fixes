import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOrderCounts } from "./reconcile-order-counts.js";

test("is consistent when every bucket matches", () => {
  const counts = { 0: 3, 1: 5, 2: 2 };
  const paginated = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2];
  const report = reconcileOrderCounts(counts, paginated);
  assert.equal(report.isConsistent, true);
  assert.deepEqual(report.mismatchedStatusIds, []);
  assert.equal(report.totalCountEndpoint, 10);
  assert.equal(report.totalPaginated, 10);
});

test("flags status_id 0 when Incomplete orders are missing from count", () => {
  const counts = { 0: 0, 1: 5 }; // count endpoint excluded Incomplete orders
  const paginated = [0, 0, 1, 1, 1, 1, 1]; // pagination still saw them
  const report = reconcileOrderCounts(counts, paginated);
  assert.equal(report.isConsistent, false);
  assert.deepEqual(report.mismatchedStatusIds, [0]);
  assert.equal(report.perStatusDeltas[0], -2);
  assert.equal(report.perStatusDeltas[1], 0);
});

test("handles a status_id present only in pagination", () => {
  const counts = { 1: 2 };
  const paginated = [1, 1, 5];
  const report = reconcileOrderCounts(counts, paginated);
  assert.deepEqual(report.mismatchedStatusIds, [5]);
  assert.equal(report.perStatusDeltas[5], -1);
});

test("handles a status_id present only in the count endpoint", () => {
  const counts = { 1: 2, 9: 4 };
  const paginated = [1, 1];
  const report = reconcileOrderCounts(counts, paginated);
  assert.deepEqual(report.mismatchedStatusIds, [9]);
  assert.equal(report.perStatusDeltas[9], 4);
});

test("empty inputs are consistent", () => {
  const report = reconcileOrderCounts({}, []);
  assert.equal(report.isConsistent, true);
  assert.equal(report.totalCountEndpoint, 0);
  assert.equal(report.totalPaginated, 0);
});

test("all fifteen status_ids can be reconciled at once", () => {
  const counts = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i, 1]));
  const paginated = Array.from({ length: 15 }, (_, i) => i);
  const report = reconcileOrderCounts(counts, paginated);
  assert.equal(report.isConsistent, true);
  assert.equal(report.totalCountEndpoint, 15);
  assert.equal(report.totalPaginated, 15);
});

test("multiple mismatched buckets are all reported", () => {
  const counts = { 0: 5, 1: 2, 2: 0 };
  const paginated = [0, 0, 1, 1, 1, 2, 2, 2];
  const report = reconcileOrderCounts(counts, paginated);
  assert.deepEqual(report.mismatchedStatusIds, [0, 1, 2]);
  assert.equal(report.perStatusDeltas[0], 3);
  assert.equal(report.perStatusDeltas[1], -1);
  assert.equal(report.perStatusDeltas[2], -3);
});
