import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRetry } from "./serialize-price-list-upserts.js";

test("success on 200", () => {
  assert.deepEqual(decideRetry(200, 1, {}), { action: "success" });
});

test("success on 201 created", () => {
  assert.deepEqual(decideRetry(201, 1, {}), { action: "success" });
});

test("success on 207 multi-status", () => {
  assert.deepEqual(decideRetry(207, 1, {}), { action: "success" });
});

test("429 retries with reset header ms", () => {
  const result = decideRetry(429, 1, { "X-Rate-Limit-Time-Reset-Ms": "1500" }, 6);
  assert.equal(result.action, "retry");
  assert.equal(result.wait_ms, 1500);
  assert.equal(result.reason, "concurrent_bulk_lock");
});

test("429 retries with retry-after seconds", () => {
  const result = decideRetry(429, 1, { "Retry-After": "2" }, 6);
  assert.equal(result.action, "retry");
  assert.equal(result.wait_ms, 2000);
  assert.equal(result.reason, "concurrent_bulk_lock");
});

test("429 falls back to capped exponential backoff", () => {
  const result = decideRetry(429, 3, {}, 6);
  assert.equal(result.action, "retry");
  // base 2000 * 2**(attempt-1) = 8000, plus up to 250ms of jitter
  assert.ok(result.wait_ms >= 8000 && result.wait_ms <= 8250);
});

test("429 backoff is capped at 60 seconds", () => {
  const result = decideRetry(429, 10, {}, 20);
  assert.equal(result.action, "retry");
  // capped at 60000, plus up to 250ms of jitter
  assert.ok(result.wait_ms >= 60000 && result.wait_ms <= 60250);
});

test("429 gives up after max attempts", () => {
  assert.deepEqual(decideRetry(429, 6, {}, 6), { action: "give_up", reason: "max_attempts_exceeded" });
});

test("non-429 client error gives up immediately", () => {
  assert.deepEqual(decideRetry(422, 1, {}, 6), { action: "give_up", reason: "client_error_non_retryable" });
});

test("401 unauthorized gives up immediately", () => {
  assert.deepEqual(decideRetry(401, 1, {}, 6), { action: "give_up", reason: "client_error_non_retryable" });
});

test("server error retries then gives up", () => {
  const retry = decideRetry(503, 1, {}, 2);
  assert.equal(retry.action, "retry");
  assert.equal(retry.reason, "server_error");
  const giveUp = decideRetry(503, 2, {}, 2);
  assert.deepEqual(giveUp, { action: "give_up", reason: "server_error_max_attempts" });
});

test("malformed reset header falls back to backoff", () => {
  const result = decideRetry(429, 1, { "X-Rate-Limit-Time-Reset-Ms": "not-a-number" }, 6);
  assert.equal(result.action, "retry");
  // base 2000 * 2**(1-1) = 2000, plus up to 250ms of jitter
  assert.ok(result.wait_ms >= 2000 && result.wait_ms <= 2250);
});
