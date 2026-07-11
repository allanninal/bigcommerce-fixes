import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePasswordUpdateOutcome } from "./recheck-password-updates.js";

test("confirmed_success when date_modified advances despite a 400", () => {
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:05Z", 400, { errors: ["stale retry"] }, 118
  );
  assert.equal(result, "confirmed_success");
});

test("needs_retry on rate limit status", () => {
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 429, {}, 118, 0
  );
  assert.equal(result, "needs_retry");
});

test("needs_retry on server error", () => {
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 500, {}, 118, 1
  );
  assert.equal(result, "needs_retry");
});

test("needs_retry on concurrency error body", () => {
  const body = { title: "Too many concurrent requests" };
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 400, body, 118, 0
  );
  assert.equal(result, "needs_retry");
});

test("needs_human_review when retries exhausted", () => {
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 429, {}, 118, 3
  );
  assert.equal(result, "needs_human_review");
});

test("needs_human_review on persistent complexity error", () => {
  const body = { title: "The password does not meet complexity requirements." };
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 400, body, 118, 0
  );
  assert.equal(result, "needs_human_review");
});

test("needs_human_review when no date_modified change and no transient signal", () => {
  const result = decidePasswordUpdateOutcome(
    "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 400, {}, 118, 0
  );
  assert.equal(result, "needs_human_review");
});
