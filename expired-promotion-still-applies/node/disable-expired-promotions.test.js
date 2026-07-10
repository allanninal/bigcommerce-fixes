import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPromotion } from "./disable-expired-promotions.js";

const NOW = "2026-07-10T00:00:00Z";

const promo = (over = {}) => ({
  status: "ENABLED",
  end_date: "2026-08-01T00:00:00Z",
  start_date: "2026-01-01T00:00:00Z",
  current_uses: 0,
  max_uses: null,
  redemption_type: "COUPON",
  ...over,
});

test("not expired when disabled already", () => {
  const result = classifyPromotion(promo({ status: "DISABLED", end_date: "2026-01-01T00:00:00Z" }), NOW);
  assert.deepEqual(result, { expired: false, reason: null, action: "NONE" });
});

test("not expired when end_date in future", () => {
  const result = classifyPromotion(promo(), NOW);
  assert.deepEqual(result, { expired: false, reason: null, action: "NONE" });
});

test("expired past end_date", () => {
  const result = classifyPromotion(promo({ end_date: "2026-06-01T00:00:00Z" }), NOW);
  assert.deepEqual(result, { expired: true, reason: "past_end_date", action: "DISABLE" });
});

test("expired when end_date equals now", () => {
  const result = classifyPromotion(promo({ end_date: NOW }), NOW);
  assert.equal(result.expired, true);
  assert.equal(result.reason, "past_end_date");
});

test("never expires with null end_date unless max_uses hit", () => {
  const result = classifyPromotion(promo({ end_date: null }), NOW);
  assert.deepEqual(result, { expired: false, reason: null, action: "NONE" });
});

test("expired when max_uses reached", () => {
  const result = classifyPromotion(promo({ end_date: null, current_uses: 50, max_uses: 50 }), NOW);
  assert.deepEqual(result, { expired: true, reason: "max_uses_reached", action: "DISABLE" });
});

test("not expired when under max_uses", () => {
  const result = classifyPromotion(promo({ end_date: null, current_uses: 49, max_uses: 50 }), NOW);
  assert.deepEqual(result, { expired: false, reason: null, action: "NONE" });
});

test("status check wins even if end_date and max_uses both expired", () => {
  const result = classifyPromotion(
    promo({ status: "DISABLED", end_date: "2026-01-01T00:00:00Z", current_uses: 50, max_uses: 50 }),
    NOW
  );
  assert.deepEqual(result, { expired: false, reason: null, action: "NONE" });
});

test("past end_date takes priority over max_uses reason", () => {
  const result = classifyPromotion(
    promo({ end_date: "2026-01-01T00:00:00Z", current_uses: 50, max_uses: 50 }),
    NOW
  );
  assert.equal(result.reason, "past_end_date");
});
