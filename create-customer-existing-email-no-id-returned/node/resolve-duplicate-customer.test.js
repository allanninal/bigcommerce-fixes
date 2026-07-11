import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDuplicateCustomerAction } from "./resolve-duplicate-customer.js";

const alreadyInUseResponse = (field = "email") => ({
  status: 422,
  title: "The email address you entered is already in use by a customer.",
  errors: { [field]: "already in use" },
});

test("flags already in use error as duplicate", () => {
  const decision = resolveDuplicateCustomerAction(alreadyInUseResponse(), ["shopper@example.com"]);
  assert.equal(decision.isDuplicateEmailError, true);
  assert.equal(decision.nextAction, "lookup_by_email");
});

test("returns all submitted emails as candidates", () => {
  const decision = resolveDuplicateCustomerAction(alreadyInUseResponse(), ["a@example.com", "b@example.com"]);
  assert.deepEqual(decision.candidateEmails, ["a@example.com", "b@example.com"]);
});

test("ignores unrelated 422 errors", () => {
  const response = { status: 422, title: "First name is required.", errors: { first_name: "required" } };
  const decision = resolveDuplicateCustomerAction(response, ["shopper@example.com"]);
  assert.equal(decision.isDuplicateEmailError, false);
  assert.equal(decision.nextAction, "raise");
  assert.deepEqual(decision.candidateEmails, []);
});

test("ignores non 422 status even with matching message", () => {
  const response = { status: 500, title: "already in use", errors: {} };
  const decision = resolveDuplicateCustomerAction(response, ["shopper@example.com"]);
  assert.equal(decision.isDuplicateEmailError, false);
});

test("matches message inside errors list form", () => {
  const response = {
    status: 422,
    title: "Unprocessable Entity",
    errors: [{ message: "Email address already in use by a customer." }],
  };
  const decision = resolveDuplicateCustomerAction(response, ["shopper@example.com"]);
  assert.equal(decision.isDuplicateEmailError, true);
});

test("no candidates when submitted emails is empty", () => {
  const decision = resolveDuplicateCustomerAction(alreadyInUseResponse(), []);
  assert.equal(decision.isDuplicateEmailError, true);
  assert.deepEqual(decision.candidateEmails, []);
});
