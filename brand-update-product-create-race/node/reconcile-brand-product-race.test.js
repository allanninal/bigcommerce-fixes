import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAction } from "./reconcile-brand-product-race.js";

test("noop_success when both confirmed", () => {
  assert.equal(decideAction(true, true, 50, 0), "noop_success");
});

test("retry_create when brand confirmed and product missing", () => {
  assert.equal(decideAction(true, false, 50, 0), "retry_create");
});

test("wait_and_retry when rate limit exhausted", () => {
  assert.equal(decideAction(true, false, 0, 1), "wait_and_retry");
});

test("flag_manual_review when brand not confirmed", () => {
  assert.equal(decideAction(false, false, 50, 0), "flag_manual_review");
});

test("flag_manual_review even if product exists but brand not confirmed", () => {
  assert.equal(decideAction(false, true, 50, 0), "flag_manual_review");
});

test("give_up after max attempts without product", () => {
  assert.equal(decideAction(true, false, 50, 5, 5), "give_up");
});

test("noop_success takes priority over give_up", () => {
  assert.equal(decideAction(true, true, 0, 5, 5), "noop_success");
});

test("retry_create at zero attempt with full rate limit", () => {
  assert.equal(decideAction(true, false, 150, 0, 5), "retry_create");
});

test("wait_and_retry takes priority over retry when rate limit zero", () => {
  assert.equal(decideAction(true, false, 0, 0, 5), "wait_and_retry");
});
