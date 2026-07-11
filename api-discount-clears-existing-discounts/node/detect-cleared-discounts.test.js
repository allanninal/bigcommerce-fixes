import { test } from "node:test";
import assert from "node:assert/strict";
import { diffDiscountState } from "./detect-cleared-discounts.js";

const snapshot = (discountIds = [], couponCodes = [], total = "100.00") => ({
  discountIds,
  couponCodes,
  totalDiscountedAmount: total,
});

test("not affected when nothing lost", () => {
  const before = snapshot(["1"], ["SAVE10"], "90.00");
  const after = snapshot(["1", "2"], ["SAVE10"], "80.00");
  const result = diffDiscountState(before, after);
  assert.equal(result.isAffected, false);
  assert.deepEqual(result.lostDiscountIds, []);
  assert.deepEqual(result.lostCouponCodes, []);
});

test("affected when coupon is lost", () => {
  const before = snapshot(["1"], ["SAVE10"], "90.00");
  const after = snapshot(["2"], [], "95.00");
  const result = diffDiscountState(before, after);
  assert.equal(result.isAffected, true);
  assert.deepEqual(result.lostDiscountIds, ["1"]);
  assert.deepEqual(result.lostCouponCodes, ["SAVE10"]);
});

test("affected when discount id is lost but coupon survives", () => {
  const before = snapshot(["1", "2"], ["SAVE10"], "90.00");
  const after = snapshot(["2"], ["SAVE10"], "92.00");
  const result = diffDiscountState(before, after);
  assert.equal(result.isAffected, true);
  assert.deepEqual(result.lostDiscountIds, ["1"]);
  assert.deepEqual(result.lostCouponCodes, []);
});

test("total delta is decimal safe", () => {
  const before = snapshot(["1"], ["SAVE10"], "90.10");
  const after = snapshot([], [], "100.00");
  const result = diffDiscountState(before, after);
  assert.equal(result.totalDelta, "-9.90");
});

test("not affected when before snapshot is empty", () => {
  const before = snapshot([], [], "100.00");
  const after = snapshot(["1"], ["SAVE10"], "90.00");
  const result = diffDiscountState(before, after);
  assert.equal(result.isAffected, false);
});

test("affected when all discounts and coupons wiped", () => {
  const before = snapshot(["1", "2"], ["SAVE10", "WELCOME"], "70.00");
  const after = snapshot([], [], "100.00");
  const result = diffDiscountState(before, after);
  assert.equal(result.isAffected, true);
  assert.deepEqual(result.lostDiscountIds, ["1", "2"]);
  assert.deepEqual(result.lostCouponCodes, ["SAVE10", "WELCOME"]);
  assert.equal(result.totalDelta, "-30.00");
});
