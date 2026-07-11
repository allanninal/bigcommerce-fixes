import { test } from "node:test";
import assert from "node:assert/strict";
import { wouldOverflowAndBeDropped } from "./check-inventory-overflow.js";

const INT32_MAX = 2147483647;

test("safe when sum is well under max", () => {
  const levels = [{ id: 1, level: 100 }, { id: 2, level: 200 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 2, 300);
  assert.equal(isUnsafe, false);
  assert.equal(projectedSum, 400);
});

test("unsafe when projected sum exceeds int32 max", () => {
  const levels = [{ id: 1, level: 2000000000 }, { id: 2, level: 100 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 2, 500000000);
  assert.equal(isUnsafe, true);
  assert.equal(projectedSum, 2500000000);
});

test("unsafe when new level alone exceeds int32 max", () => {
  const levels = [{ id: 1, level: 0 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 1, INT32_MAX + 1);
  assert.equal(isUnsafe, true);
  assert.equal(projectedSum, INT32_MAX + 1);
});

test("safe at exactly int32 max", () => {
  const levels = [{ id: 1, level: 0 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 1, INT32_MAX);
  assert.equal(isUnsafe, false);
  assert.equal(projectedSum, INT32_MAX);
});

test("excludes target variant current level from the sum", () => {
  const levels = [{ id: 1, level: INT32_MAX }, { id: 2, level: 50 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 1, 10);
  assert.equal(isUnsafe, false);
  assert.equal(projectedSum, 60);
});

test("other variants pushing sum over max is unsafe", () => {
  const levels = [{ id: 1, level: INT32_MAX - 10 }, { id: 2, level: 0 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 2, 11);
  assert.equal(isUnsafe, true);
  assert.equal(projectedSum, INT32_MAX + 1);
});

test("negative new level reduces the projected sum", () => {
  const levels = [{ id: 1, level: 100 }];
  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, 2, -50);
  assert.equal(isUnsafe, false);
  assert.equal(projectedSum, 50);
});
