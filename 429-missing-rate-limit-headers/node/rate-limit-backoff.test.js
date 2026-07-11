import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffSeconds } from "./rate-limit-backoff.js";

test("non-429 needs no backoff", () => {
  assert.equal(computeBackoffSeconds(200, {}, 0), 0);
  assert.equal(computeBackoffSeconds(500, { "X-Rate-Limit-Time-Reset-Ms": "2000" }, 0), 0);
});

test("headers present returns exact reset seconds", () => {
  const headers = { "X-Rate-Limit-Time-Reset-Ms": "2500" };
  assert.equal(computeBackoffSeconds(429, headers, 0), 2.5);
});

test("headers present is case insensitive", () => {
  const headers = { "x-rate-limit-time-reset-ms": "1000" };
  assert.equal(computeBackoffSeconds(429, headers, 0), 1.0);
});

test("headers missing falls back to bounded exponential backoff", () => {
  const wait = computeBackoffSeconds(429, {}, 3, 1.0, 60.0, 0.2);
  // attempt 3 -> base 8s +/- 20% jitter, well under the 60s cap
  assert.ok(wait >= 6.0 && wait <= 10.0);
});

test("headers missing backoff is capped", () => {
  const wait = computeBackoffSeconds(429, {}, 20, 1.0, 60.0, 0.2);
  assert.ok(wait <= 60.0 * 1.2);
});

test("attempts produce monotonically non-decreasing backoff up to cap", () => {
  let previous = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const baseWait = Math.min(1.0 * 2 ** attempt, 60.0);
    assert.ok(baseWait >= previous);
    previous = baseWait;
  }
});

test("unparseable reset header falls back to backoff", () => {
  const wait = computeBackoffSeconds(429, { "X-Rate-Limit-Time-Reset-Ms": "not-a-number" }, 0);
  assert.ok(wait > 0);
});

test("empty reset header falls back to backoff", () => {
  const wait = computeBackoffSeconds(429, { "X-Rate-Limit-Time-Reset-Ms": "" }, 0);
  assert.ok(wait > 0);
});

test("zero attempt headers missing gives base seconds with jitter", () => {
  const wait = computeBackoffSeconds(429, {}, 0, 1.0, 60.0, 0.2);
  assert.ok(wait >= 0.8 && wait <= 1.2);
});
