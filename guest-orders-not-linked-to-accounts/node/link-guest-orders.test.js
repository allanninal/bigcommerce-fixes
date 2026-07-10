import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOrderLink } from "./link-guest-orders.js";

const order = (over = {}) => ({
  id: 101, customer_id: 0, billing_email: "jane@example.com", status_id: 11, ...over,
});

const match = (id = 555, email = "jane@example.com") => ({ id, email });

test("link when exactly one confident match", () => {
  const decision = decideOrderLink(order(), [match()]);
  assert.equal(decision.action, "link");
  assert.equal(decision.targetCustomerId, 555);
});

test("link is case and whitespace insensitive", () => {
  const decision = decideOrderLink(
    order({ billing_email: "  Jane@Example.com  " }),
    [match(555, "jane@example.com")],
  );
  assert.equal(decision.action, "link");
  assert.equal(decision.targetCustomerId, 555);
});

test("skip when already linked to a customer", () => {
  const decision = decideOrderLink(order({ customer_id: 42 }), [match()]);
  assert.equal(decision.action, "skip");
  assert.equal(decision.targetCustomerId, null);
});

test("skip when status incomplete", () => {
  const decision = decideOrderLink(order({ status_id: 0 }), [match()]);
  assert.equal(decision.action, "skip");
});

test("skip when status cancelled", () => {
  const decision = decideOrderLink(order({ status_id: 5 }), [match()]);
  assert.equal(decision.action, "skip");
});

test("skip when status declined", () => {
  const decision = decideOrderLink(order({ status_id: 6 }), [match()]);
  assert.equal(decision.action, "skip");
});

test("flag when no matches", () => {
  const decision = decideOrderLink(order(), []);
  assert.equal(decision.action, "flag");
  assert.equal(decision.targetCustomerId, null);
});

test("flag when multiple matches", () => {
  const decision = decideOrderLink(order(), [match(1, "jane@example.com"), match(2, "jane@example.com")]);
  assert.equal(decision.action, "flag");
  assert.equal(decision.targetCustomerId, null);
});

test("flag when email does not match exactly", () => {
  const decision = decideOrderLink(order({ billing_email: "jane@example.com" }), [match(555, "j.ane@example.com")]);
  assert.equal(decision.action, "flag");
  assert.equal(decision.targetCustomerId, null);
});
