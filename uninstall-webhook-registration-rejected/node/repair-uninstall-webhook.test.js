import { test } from "node:test";
import assert from "node:assert/strict";
import { findUninstallScopeGap } from "./repair-uninstall-webhook.js";

const hook = (scope, { isActive = true, id = 1, destination = "https://example.com/hook" } = {}) => ({
  id, scope, destination, is_active: isActive,
});

test("missing when hooks list is empty", () => {
  assert.deepEqual(findUninstallScopeGap([]), { status: "missing" });
});

test("ok when exact scope is active", () => {
  const hooks = [hook("store/app/uninstalled", { isActive: true, id: 42 })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "ok" });
});

test("inactive when exact scope is not active", () => {
  const hooks = [hook("store/app/uninstalled", { isActive: false, id: 42 })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "inactive", hook_id: 42 });
});

test("near_miss when present tense variant exists", () => {
  const hooks = [hook("store/app/uninstall", { id: 7 })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "near_miss", hook_id: 7, found_scope: "store/app/uninstall" });
});

test("missing when only unrelated scopes exist", () => {
  const hooks = [hook("store/order/statusUpdated", { id: 1 }), hook("store/cart/updated", { id: 2 })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "missing" });
});

test("ok takes priority even if a near miss also exists", () => {
  const hooks = [hook("store/app/uninstall", { id: 7 }), hook("store/app/uninstalled", { id: 8, isActive: true })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "ok" });
});

test("inactive reported even when a near miss is also present", () => {
  const hooks = [hook("store/app/uninstall", { id: 7 }), hook("store/app/uninstalled", { id: 8, isActive: false })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "inactive", hook_id: 8 });
});

test("first near miss wins when multiple near misses exist", () => {
  const hooks = [hook("store/app/uninstall", { id: 5 }), hook("app/uninstalled", { id: 6 })];
  assert.deepEqual(findUninstallScopeGap(hooks), { status: "near_miss", hook_id: 5, found_scope: "store/app/uninstall" });
});

test("custom expected scope argument is respected", () => {
  const hooks = [hook("store/custom/scope", { id: 9, isActive: true })];
  assert.deepEqual(findUninstallScopeGap(hooks, "store/custom/scope"), { status: "ok" });
});
