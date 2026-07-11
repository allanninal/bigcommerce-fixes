import { test } from "node:test";
import assert from "node:assert/strict";
import { planCouponUpdate } from "./reconcile-coupon-applies-to.js";

const fixtureSnapshot = (overrides = {}) => ({
  id: 1,
  code: "SAVE10",
  type: "percentage_discount",
  amount: "10.0000000000",
  max_uses: 100,
  num_uses: 42,
  applies_to: { entity: "products", ids: [123, 456] },
  ...overrides,
});

test("merges desired changes onto a full snapshot", () => {
  const plan = planCouponUpdate(fixtureSnapshot(), { max_uses: 50 });
  assert.equal(plan.method, "PUT");
  assert.equal(plan.path, "/coupons/1");
  assert.equal(plan.body.max_uses, 50);
});

test("body always reasserts applies_to when not in desired changes", () => {
  const plan = planCouponUpdate(fixtureSnapshot(), { max_uses: 50 });
  assert.deepEqual(plan.body.applies_to, { entity: "products", ids: [123, 456] });
});

test("body never omits untouched fields", () => {
  const plan = planCouponUpdate(fixtureSnapshot(), { max_uses: 50 });
  assert.equal(plan.body.code, "SAVE10");
  assert.equal(plan.body.num_uses, 42);
});

test("wipeRiskFields flags applies_to when omitted", () => {
  const plan = planCouponUpdate(fixtureSnapshot(), { max_uses: 50 });
  assert.deepEqual(plan.wipeRiskFields, ["applies_to"]);
});

test("wipeRiskFields is empty when applies_to is the intended change", () => {
  const newAppliesTo = { entity: "categories", ids: [9] };
  const plan = planCouponUpdate(fixtureSnapshot(), { applies_to: newAppliesTo });
  assert.deepEqual(plan.wipeRiskFields, []);
  assert.deepEqual(plan.body.applies_to, newAppliesTo);
});

test("body never includes the id field", () => {
  const plan = planCouponUpdate(fixtureSnapshot(), { max_uses: 50 });
  assert.equal("id" in plan.body, false);
});

test("throws when snapshot has no id", () => {
  assert.throws(() => planCouponUpdate({ code: "SAVE10" }, { max_uses: 50 }));
});
