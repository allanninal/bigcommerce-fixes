import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldThrottle } from "./rate-limit-guard.js";

test("no throttle when requests left above threshold", () => {
  assert.deepEqual(shouldThrottle(50, 30000, 10, 200), [false, 0]);
});

test("throttle when requests left below threshold", () => {
  const [throttle, waitMs] = shouldThrottle(5, 30000, 10, 200);
  assert.equal(throttle, true);
  assert.equal(waitMs, 30000);
});

test("throttle when requests left equals threshold", () => {
  const [throttle] = shouldThrottle(10, 15000, 10, 200);
  assert.equal(throttle, true);
});

test("throttle on 429 even when requests left still high", () => {
  const [throttle, waitMs] = shouldThrottle(120, 8000, 10, 429);
  assert.equal(throttle, true);
  assert.equal(waitMs, 8000);
});

test("throttle with zero time reset ms returns zero wait", () => {
  const [throttle, waitMs] = shouldThrottle(2, 0, 10, 200);
  assert.equal(throttle, true);
  assert.equal(waitMs, 0);
});

test("missing requests left defaults to throttle", () => {
  const [throttle] = shouldThrottle(null, 30000, 10, 200);
  assert.equal(throttle, true);
});

test("negative time reset ms defaults to zero wait", () => {
  const [throttle, waitMs] = shouldThrottle(5, -100, 10, 200);
  assert.equal(throttle, true);
  assert.equal(waitMs, 0);
});

test("negative requests left defaults to throttle", () => {
  const [throttle] = shouldThrottle(-1, 30000, 10, 200);
  assert.equal(throttle, true);
});
