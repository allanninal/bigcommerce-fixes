import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCouponUsage } from "./reconcile-coupon-usage.js";

const coupon = ({ id = 1, code = "SAVE10", numUses = 5 } = {}) => ({ id, code, numUses });
const order = (orderId, statusId, couponCode = "SAVE10") => ({ orderId, statusId, couponCode });

test("no drift when reported matches true", () => {
  const orders = [order(1, 10), order(2, 10), order(3, 2)];
  const result = reconcileCouponUsage(coupon({ numUses: 3 }), orders);
  assert.equal(result.trueUses, 3);
  assert.equal(result.delta, 0);
  assert.equal(result.drifted, false);
  assert.deepEqual(result.offendingOrderIds, []);
});

test("drift when cancelled orders still counted", () => {
  const orders = [order(1, 10), order(2, 5), order(3, 6)];
  const result = reconcileCouponUsage(coupon({ numUses: 3 }), orders);
  assert.equal(result.trueUses, 1);
  assert.equal(result.delta, 2);
  assert.equal(result.drifted, true);
  assert.deepEqual(result.offendingOrderIds, [2, 3]);
});

test("refunded and partially refunded are offending", () => {
  const orders = [order(1, 10), order(2, 4), order(3, 14)];
  const result = reconcileCouponUsage(coupon({ numUses: 3 }), orders);
  assert.equal(result.trueUses, 1);
  assert.deepEqual(result.offendingOrderIds, [2, 3]);
});

test("no orders at all is full delta", () => {
  const result = reconcileCouponUsage(coupon({ numUses: 4 }), []);
  assert.equal(result.trueUses, 0);
  assert.equal(result.delta, 4);
  assert.equal(result.drifted, true);
  assert.deepEqual(result.offendingOrderIds, []);
});

test("tolerance absorbs small delta", () => {
  const orders = [order(1, 10)];
  const result = reconcileCouponUsage(coupon({ numUses: 2 }), orders, undefined, 1);
  assert.equal(result.delta, 1);
  assert.equal(result.drifted, false);
});

test("negative delta is not drifted", () => {
  const orders = [order(1, 10), order(2, 10), order(3, 10)];
  const result = reconcileCouponUsage(coupon({ numUses: 1 }), orders);
  assert.equal(result.delta, -2);
  assert.equal(result.drifted, false);
});

test("offending order ids sorted", () => {
  const orders = [order(9, 5), order(2, 6), order(7, 0)];
  const result = reconcileCouponUsage(coupon({ numUses: 3 }), orders);
  assert.deepEqual(result.offendingOrderIds, [2, 7, 9]);
});

test("awaiting payment counts as valid", () => {
  const orders = [order(1, 7)];
  const result = reconcileCouponUsage(coupon({ numUses: 1 }), orders);
  assert.equal(result.trueUses, 1);
  assert.equal(result.drifted, false);
});
