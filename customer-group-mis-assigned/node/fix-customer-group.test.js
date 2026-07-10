import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGroupReassignment } from "./fix-customer-group.js";

const EMAIL_DOMAIN_RULE = {
  matchType: "email_domain",
  pattern: "wholesale-buyer.example",
  targetGroupId: 3,
  fallbackGroupId: 0,
};

const SPEND_RULE = {
  matchType: "spend_threshold",
  thresholdCents: 500000,
  targetGroupId: 5,
  fallbackGroupId: 0,
};

const customer = (over = {}) => ({ id: 101, customer_group_id: 0, email: "buyer@retail.example", ...over });

test("domain match needs reassignment", () => {
  const decision = decideGroupReassignment(customer({ email: "ana@wholesale-buyer.example" }), EMAIL_DOMAIN_RULE);
  assert.equal(decision.needsReassignment, true);
  assert.equal(decision.expectedGroupId, 3);
  assert.equal(decision.currentGroupId, 0);
});

test("domain no match falls back and is already correct", () => {
  const decision = decideGroupReassignment(customer({ customer_group_id: 0 }), EMAIL_DOMAIN_RULE);
  assert.equal(decision.needsReassignment, false);
  assert.equal(decision.expectedGroupId, 0);
});

test("spend threshold match", () => {
  const c = customer({ total_lifetime_spend_cents: 600000, customer_group_id: 0 });
  const decision = decideGroupReassignment(c, SPEND_RULE);
  assert.equal(decision.needsReassignment, true);
  assert.equal(decision.expectedGroupId, 5);
});

test("spend missing field defaults to fallback", () => {
  const c = customer({ customer_group_id: 5 });
  const decision = decideGroupReassignment(c, SPEND_RULE);
  assert.equal(decision.expectedGroupId, 0);
  assert.equal(decision.needsReassignment, true);
});

test("already correct group needs no reassignment", () => {
  const c = customer({ email: "ana@wholesale-buyer.example", customer_group_id: 3 });
  const decision = decideGroupReassignment(c, EMAIL_DOMAIN_RULE);
  assert.deepEqual(decision, {
    customerId: 101,
    currentGroupId: 3,
    expectedGroupId: 3,
    needsReassignment: false,
    reason: "email domain \"wholesale-buyer.example\" matches \"wholesale-buyer.example\"; already in the correct group 3",
  });
});

test("unknown match type defaults to fallback", () => {
  const rule = { matchType: "mystery", targetGroupId: 9, fallbackGroupId: 2 };
  const decision = decideGroupReassignment(customer({ customer_group_id: 2 }), rule);
  assert.equal(decision.needsReassignment, false);
  assert.equal(decision.expectedGroupId, 2);
});

test("tax exempt match", () => {
  const rule = { matchType: "tax_exempt", targetGroupId: 8, fallbackGroupId: 0 };
  const decision = decideGroupReassignment(customer({ tax_exempt_category: "wholesale", customer_group_id: 0 }), rule);
  assert.equal(decision.needsReassignment, true);
  assert.equal(decision.expectedGroupId, 8);
});

test("source tag match", () => {
  const rule = { matchType: "source_tag", pattern: "b2b-portal", targetGroupId: 6, fallbackGroupId: 0 };
  const decision = decideGroupReassignment(customer({ registration_source: "b2b-portal", customer_group_id: 0 }), rule);
  assert.equal(decision.needsReassignment, true);
  assert.equal(decision.expectedGroupId, 6);
});
