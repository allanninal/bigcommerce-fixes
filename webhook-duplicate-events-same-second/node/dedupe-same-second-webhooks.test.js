import { test } from "node:test";
import assert from "node:assert/strict";
import { isDuplicateWebhookEvent } from "./dedupe-same-second-webhooks.js";

test("first event is not a duplicate", () => {
  const seen = new Map();
  assert.equal(isDuplicateWebhookEvent(seen, 501, 11, 1000.0), false);
  assert.equal(seen.get("501:11"), 1000.0);
});

test("second event within window is a duplicate", () => {
  const seen = new Map([["501:11", 1000.0]]);
  assert.equal(isDuplicateWebhookEvent(seen, 501, 11, 1000.8), true);
});

test("event exactly at window edge is a duplicate", () => {
  const seen = new Map([["501:11", 1000.0]]);
  assert.equal(isDuplicateWebhookEvent(seen, 501, 11, 1002.0, 2.0), true);
});

test("event just outside window is not a duplicate", () => {
  const seen = new Map([["501:11", 1000.0]]);
  assert.equal(isDuplicateWebhookEvent(seen, 501, 11, 1002.1, 2.0), false);
});

test("out of order timestamp within window is still a duplicate", () => {
  const seen = new Map([["501:11", 1005.0]]);
  assert.equal(isDuplicateWebhookEvent(seen, 501, 11, 1004.0, 2.0), true);
});

test("different status id is a distinct event, not a duplicate", () => {
  const seen = new Map([["501:11", 1000.0]]);
  assert.equal(isDuplicateWebhookEvent(seen, 501, 12, 1000.2), false);
});

test("different resource id is a distinct event, not a duplicate", () => {
  const seen = new Map([["501:11", 1000.0]]);
  assert.equal(isDuplicateWebhookEvent(seen, 502, 11, 1000.2), false);
});
