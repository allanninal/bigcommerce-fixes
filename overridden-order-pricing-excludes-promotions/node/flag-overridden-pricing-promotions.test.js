import { test } from "node:test";
import assert from "node:assert/strict";
import { flagMissingPromotion, recommendedAction, overrideAmount } from "./flag-overridden-pricing-promotions.js";

const baseOrder = (overrides = {}) => ({
  id: 501,
  discount_amount: "0.00",
  coupon_discount: "0.00",
  subtotal_ex_tax: "80.00",
  base_total_ex_tax: "100.00",
  customer_group_id: 0,
  date_created: "2026-07-01",
  ...overrides,
});

const overrideLineItem = ({ price_ex_tax = "80.00", base_price = "100.00", applied_discounts = [] } = {}) => ({
  product_id: 42,
  price_ex_tax,
  base_price,
  applied_discounts,
});

const automaticPromo = (id = 9001) => ({ id, redemption_type: "AUTOMATIC", rules: [], current_days_and_times: {} });

test("flags override with no discount and active automatic promo", () => {
  const flag = flagMissingPromotion(baseOrder(), [overrideLineItem()], [], [automaticPromo()]);
  assert.deepEqual(flag, {
    order_id: 501,
    reason: "price_override_excluded_from_active_automatic_promotion",
    has_price_override: true,
    expected_promo_ids: [9001],
  });
});

test("no flag when price matches base price", () => {
  const lineItems = [overrideLineItem({ price_ex_tax: "100.00", base_price: "100.00" })];
  assert.equal(flagMissingPromotion(baseOrder(), lineItems, [], [automaticPromo()]), null);
});

test("no flag when discount_amount is recorded", () => {
  const order = baseOrder({ discount_amount: "10.00" });
  assert.equal(flagMissingPromotion(order, [overrideLineItem()], [], [automaticPromo()]), null);
});

test("no flag when order coupons present", () => {
  const coupons = [{ code: "SAVE10", amount: "10.00", type: "percentage_discount" }];
  assert.equal(flagMissingPromotion(baseOrder(), [overrideLineItem()], coupons, [automaticPromo()]), null);
});

test("no flag when line item has applied_discounts", () => {
  const lineItems = [overrideLineItem({ applied_discounts: [{ amount: "5.00" }] })];
  assert.equal(flagMissingPromotion(baseOrder(), lineItems, [], [automaticPromo()]), null);
});

test("no flag when no active automatic promotion exists", () => {
  const couponOnlyPromo = { id: 1, redemption_type: "COUPON", rules: [], current_days_and_times: {} };
  assert.equal(flagMissingPromotion(baseOrder(), [overrideLineItem()], [], [couponOnlyPromo]), null);
});

test("no flag when no price override present", () => {
  const lineItems = [{ product_id: 42, price_ex_tax: null, base_price: "100.00", applied_discounts: [] }];
  assert.equal(flagMissingPromotion(baseOrder(), lineItems, [], [automaticPromo()]), null);
});

test("flags multiple eligible automatic promotions", () => {
  const promos = [automaticPromo(1), automaticPromo(2), { id: 3, redemption_type: "COUPON", rules: [] }];
  const flag = flagMissingPromotion(baseOrder(), [overrideLineItem()], [], promos);
  assert.deepEqual(flag.expected_promo_ids, [1, 2]);
});

test("recommendedAction flags settled orders as flag_only_settled_order", () => {
  assert.equal(recommendedAction(2), "flag_only_settled_order");
  assert.equal(recommendedAction(10), "flag_only_settled_order");
  assert.equal(recommendedAction(14), "flag_only_settled_order");
});

test("recommendedAction flags pre-capture orders as guarded-repair eligible", () => {
  assert.equal(recommendedAction(0), "flag_or_guarded_repair_pre_capture");
  assert.equal(recommendedAction(7), "flag_or_guarded_repair_pre_capture");
});

test("recommendedAction defaults to flag_only for other statuses", () => {
  assert.equal(recommendedAction(11), "flag_only");
});

test("overrideAmount sums absolute differences across line items", () => {
  const lineItems = [
    overrideLineItem({ price_ex_tax: "80.00", base_price: "100.00" }),
    overrideLineItem({ price_ex_tax: "45.50", base_price: "50.00" }),
  ];
  assert.equal(overrideAmount(baseOrder(), lineItems), 24.5);
});
