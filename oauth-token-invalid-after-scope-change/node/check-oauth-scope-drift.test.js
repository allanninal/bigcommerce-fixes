import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAuthFailure, scopeSet } from "./check-oauth-scope-drift.js";

test("OK when status is not 401", () => {
  const scopes = new Set(["store_v2_orders"]);
  assert.equal(classifyAuthFailure(200, scopes, scopes, 0), "OK");
});

test("SCOPE_DRIFT when required scope is missing", () => {
  const stored = new Set(["store_v2_orders"]);
  const required = new Set(["store_v2_orders", "store_v2_customers"]);
  assert.equal(classifyAuthFailure(401, stored, required, 0), "SCOPE_DRIFT");
});

test("SCOPE_DRIFT wins even on first attempt", () => {
  const stored = new Set(["store_v2_products"]);
  const required = new Set(["store_v2_products", "store_v2_orders"]);
  assert.equal(classifyAuthFailure(401, stored, required, 0), "SCOPE_DRIFT");
});

test("TRANSIENT_RETRY when scopes match and first attempt", () => {
  const scopes = new Set(["store_v2_orders", "store_v2_products"]);
  assert.equal(classifyAuthFailure(401, scopes, scopes, 0), "TRANSIENT_RETRY");
});

test("TOKEN_REVOKED_OR_EXPIRED when scopes match after retry", () => {
  const scopes = new Set(["store_v2_orders", "store_v2_products"]);
  assert.equal(classifyAuthFailure(401, scopes, scopes, 1), "TOKEN_REVOKED_OR_EXPIRED");
});

test("TOKEN_REVOKED_OR_EXPIRED stays final on further retries", () => {
  const scopes = new Set(["store_v2_orders"]);
  assert.equal(classifyAuthFailure(401, scopes, scopes, 3), "TOKEN_REVOKED_OR_EXPIRED");
});

test("scopeSet parses a space separated scope string", () => {
  const scopes = scopeSet("store_v2_orders store_v2_products");
  assert.equal(scopes.has("store_v2_orders"), true);
  assert.equal(scopes.has("store_v2_products"), true);
  assert.equal(scopes.size, 2);
});

test("scopeSet returns an empty set for an empty string", () => {
  assert.equal(scopeSet("").size, 0);
  assert.equal(scopeSet(undefined).size, 0);
});
