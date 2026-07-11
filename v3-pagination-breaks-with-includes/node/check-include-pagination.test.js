import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcilePaginatedProductIds } from "./check-include-pagination.js";

function page(ids, total, totalPages, perPage = 10) {
  return {
    data: ids.map((id) => ({ id })),
    meta: { pagination: { total, total_pages: totalPages, per_page: perPage } },
  };
}

function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

test("trustworthy when all ids present and total_pages covers them", () => {
  const baselineIds = range(1, 21).map(String);
  const pages = [page(range(1, 11), 20, 2), page(range(11, 21), 20, 2)];
  const result = reconcilePaginatedProductIds(baselineIds, pages);
  assert.deepEqual(result.missingIds, []);
  assert.equal(result.paginationTrustworthy, true);
  assert.equal(result.recommendedStopCondition, "total_pages");
});

test("untrustworthy when include pull is truncated by total_pages", () => {
  const baselineIds = range(1, 31).map(String);
  const pages = [page(range(1, 11), 30, 1, 10)];
  const result = reconcilePaginatedProductIds(baselineIds, pages);
  assert.deepEqual(result.missingIds, range(11, 31).map(String));
  assert.equal(result.paginationTrustworthy, false);
  assert.equal(result.recommendedStopCondition, "empty_data_array");
});

test("untrustworthy when ids missing even if total_pages looks sufficient", () => {
  const baselineIds = range(1, 11).map(String);
  const pages = [page(range(1, 9), 10, 1, 10)];
  const result = reconcilePaginatedProductIds(baselineIds, pages);
  assert.deepEqual(result.missingIds, ["9", "10"]);
  assert.equal(result.paginationTrustworthy, false);
  assert.equal(result.recommendedStopCondition, "empty_data_array");
});

test("trustworthy when baseline is empty", () => {
  const result = reconcilePaginatedProductIds([], [page([], 0, 0)]);
  assert.deepEqual(result.missingIds, []);
  assert.equal(result.paginationTrustworthy, true);
  assert.equal(result.recommendedStopCondition, "total_pages");
});

test("multi-page include pull with all ids covered", () => {
  const baselineIds = range(1, 26).map(String);
  const pages = [
    page(range(1, 11), 25, 3, 10),
    page(range(11, 21), 25, 3, 10),
    page(range(21, 26), 25, 3, 10),
  ];
  const result = reconcilePaginatedProductIds(baselineIds, pages);
  assert.deepEqual(result.missingIds, []);
  assert.equal(result.paginationTrustworthy, true);
  assert.equal(result.recommendedStopCondition, "total_pages");
});
