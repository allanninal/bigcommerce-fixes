import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCouponOverwrite } from "./detect-coupon-overwrite.js";

const snapshot = ({ couponDiscount = 10, totalIncTax = 90, dateModified = "2026-07-01T10:00:00Z" } = {}) => ({
  orderId: 501, couponDiscount, totalIncTax, totalExTax: totalIncTax, dateModified,
});

const live = ({ couponDiscount = 10, totalIncTax = 90, dateModified = "2026-07-01T10:00:00Z" } = {}) => ({
  orderId: 501, couponDiscount, totalIncTax, totalExTax: totalIncTax, dateModified,
});

const coupon = ({ discount = 10, code = "SAVE10" } = {}) => ({ code, discount, type: 1 });

test("not corrupted when nothing changed", () => {
  const result = detectCouponOverwrite(snapshot(), live(), [coupon()]);
  assert.equal(result.isCorrupted, false);
});

test("not corrupted when no active coupon", () => {
  const result = detectCouponOverwrite(
    snapshot({ couponDiscount: 0 }),
    live({ couponDiscount: 0 }),
    []
  );
  assert.equal(result.isCorrupted, false);
});

test("corrupted when discount wiped but total unchanged", () => {
  const liveOrder = live({ couponDiscount: 0, totalIncTax: 90, dateModified: "2026-07-05T10:00:00Z" });
  const result = detectCouponOverwrite(snapshot(), liveOrder, [coupon()]);
  assert.equal(result.isCorrupted, true);
  // The full 10 discount dropped off couponDiscount (10 -> 0), which exactly
  // matches expectedDiscount, so deltaMissing (the shortfall between what
  // disappeared from couponDiscount and what the coupon says should have
  // applied) is 0. isCorrupted is driven by the total not falling to match.
  assert.equal(result.deltaMissing, 0);
});

test("delta missing reflects a partial drop in coupon discount", () => {
  // couponDiscount only fell from 10 to 6 (a drop of 4, not the full 10), so
  // deltaMissing = expectedDiscount - actualDrop = 6.
  const liveOrder = live({ couponDiscount: 6, totalIncTax: 90, dateModified: "2026-07-05T10:00:00Z" });
  const result = detectCouponOverwrite(snapshot(), liveOrder, [coupon()]);
  assert.equal(result.isCorrupted, true);
  assert.equal(result.deltaMissing, 6);
});

test("not corrupted when total dropped by the expected discount", () => {
  const liveOrder = live({ couponDiscount: 0, totalIncTax: 80, dateModified: "2026-07-05T10:00:00Z" });
  const result = detectCouponOverwrite(snapshot(), liveOrder, [coupon()]);
  assert.equal(result.isCorrupted, false);
});

test("not corrupted when discount increased", () => {
  const liveOrder = live({ couponDiscount: 15, totalIncTax: 85, dateModified: "2026-07-05T10:00:00Z" });
  const result = detectCouponOverwrite(snapshot(), liveOrder, [coupon({ discount: 15 })]);
  assert.equal(result.isCorrupted, false);
});

test("corrupted when total drop only partially covers the discount", () => {
  const liveOrder = live({ couponDiscount: 0, totalIncTax: 88, dateModified: "2026-07-05T10:00:00Z" });
  const result = detectCouponOverwrite(snapshot(), liveOrder, [coupon()]);
  assert.equal(result.isCorrupted, true);
});

test("not corrupted when date modified is unchanged even if values differ", () => {
  const liveOrder = live({ couponDiscount: 0, totalIncTax: 90, dateModified: "2026-07-01T10:00:00Z" });
  const result = detectCouponOverwrite(snapshot(), liveOrder, [coupon()]);
  assert.equal(result.isCorrupted, false);
});
