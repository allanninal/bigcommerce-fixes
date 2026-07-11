import { test } from "node:test";
import assert from "node:assert/strict";
import { isTruncated } from "./reconcile-truncated-skus.js";

test("no limit requested and records equal the default while total exceeds it", () => {
  assert.equal(isTruncated(50, null, 80), true);
});

test("no limit requested and total equals records fetched", () => {
  assert.equal(isTruncated(50, null, 50), false);
});

test("no limit requested and records fetched under the default", () => {
  assert.equal(isTruncated(30, null, 30), false);
});

test("explicit limit requested and records fall short of the true total", () => {
  assert.equal(isTruncated(200, 250, 260), true);
});

test("explicit limit requested and records match the smaller of limit and total", () => {
  assert.equal(isTruncated(100, 250, 100), false);
});

test("explicit limit requested and records match the limit itself", () => {
  assert.equal(isTruncated(250, 250, 250), false);
});
