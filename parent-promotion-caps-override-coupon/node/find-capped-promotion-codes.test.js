import { test } from "node:test";
import assert from "node:assert/strict";
import { findCappedOutCodes } from "./find-capped-promotion-codes.js";

const promotion = ({ max_uses = 50, current_uses = 0, status = "ENABLED" } = {}) => ({
  id: 1, max_uses, current_uses, status,
});

const code = ({ id = 1, code: c = "SAVE10", max_uses = 500, current_uses = 0 } = {}) => ({
  id, code: c, max_uses, current_uses,
});

test("ok when promotion has more room than code", () => {
  const promo = promotion({ max_uses: 500, current_uses: 10 });
  const result = findCappedOutCodes(promo, [code({ max_uses: 50, current_uses: 5 })]);
  assert.equal(result[0].reason, "ok");
});

test("promotion_exhausted when current_uses reaches max", () => {
  const promo = promotion({ max_uses: 50, current_uses: 50 });
  const result = findCappedOutCodes(promo, [code({ max_uses: 500, current_uses: 40 })]);
  assert.equal(result[0].reason, "promotion_exhausted");
  assert.equal(result[0].promotion_remaining, 0);
});

test("promotion_cap_lower_than_code when code remaining exceeds promotion", () => {
  const promo = promotion({ max_uses: 50, current_uses: 40 });
  const result = findCappedOutCodes(promo, [code({ max_uses: 500, current_uses: 40 })]);
  assert.equal(result[0].reason, "promotion_cap_lower_than_code");
  assert.equal(result[0].promotion_remaining, 10);
  assert.equal(result[0].code_remaining, 460);
});

test("unlimited code is flagged when promotion is capped", () => {
  const promo = promotion({ max_uses: 50, current_uses: 10 });
  const result = findCappedOutCodes(promo, [code({ max_uses: 0, current_uses: 0 })]);
  assert.equal(result[0].reason, "promotion_cap_lower_than_code");
  assert.equal(result[0].code_remaining, null);
});

test("unlimited promotion never gates a code", () => {
  const promo = promotion({ max_uses: 0, current_uses: 999 });
  const result = findCappedOutCodes(promo, [code({ max_uses: 500, current_uses: 0 })]);
  assert.equal(result[0].reason, "ok");
  assert.equal(result[0].promotion_remaining, null);
});

test("multiple codes are each classified independently", () => {
  const promo = promotion({ max_uses: 50, current_uses: 45 });
  const codes = [code({ id: 1, max_uses: 10, current_uses: 8 }), code({ id: 2, max_uses: 500, current_uses: 0 })];
  const result = findCappedOutCodes(promo, codes);
  const byId = Object.fromEntries(result.map((r) => [r.code_id, r.reason]));
  assert.equal(byId[1], "ok");
  assert.equal(byId[2], "promotion_cap_lower_than_code");
});

test("promotion_exhausted takes priority even if code is also unlimited", () => {
  const promo = promotion({ max_uses: 10, current_uses: 10 });
  const result = findCappedOutCodes(promo, [code({ max_uses: 0, current_uses: 0 })]);
  assert.equal(result[0].reason, "promotion_exhausted");
});
