import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHook } from "./reconcile-orphaned-webhooks.js";

const NOW = 1_800_000_000;
const DAY = 86400;

const makeHook = ({ clientId = "client_unknown", isActive = false, updatedAt = NOW } = {}) => ({
  id: 1,
  client_id: clientId,
  scope: "store/order/*",
  destination: "https://example.com/hooks",
  is_active: isActive,
  created_at: updatedAt,
  updated_at: updatedAt,
});

test("keep when client_id is known", () => {
  const hook = makeHook({ clientId: "client_known" });
  assert.equal(classifyHook(hook, new Set(["client_known"]), NOW), "keep");
});

test("orphan_delete when unowned and stale inactive", () => {
  const hook = makeHook({ isActive: false, updatedAt: NOW - 91 * DAY });
  assert.equal(classifyHook(hook, new Set(["client_known"]), NOW), "orphan_delete");
});

test("orphan_flag_only when unowned and still active", () => {
  const hook = makeHook({ isActive: true, updatedAt: NOW - 200 * DAY });
  assert.equal(classifyHook(hook, new Set(["client_known"]), NOW), "orphan_flag_only");
});

test("stale_inactive when unowned but recently deactivated", () => {
  const hook = makeHook({ isActive: false, updatedAt: NOW - 10 * DAY });
  assert.equal(classifyHook(hook, new Set(["client_known"]), NOW), "stale_inactive");
});

test("orphan_delete respects custom staleAfterDays", () => {
  const hook = makeHook({ isActive: false, updatedAt: NOW - 31 * DAY });
  assert.equal(classifyHook(hook, new Set(["client_known"]), NOW, 30), "orphan_delete");
});

test("keep wins even if hook would otherwise look orphaned", () => {
  const hook = makeHook({ clientId: "client_known", isActive: false, updatedAt: NOW - 500 * DAY });
  assert.equal(classifyHook(hook, new Set(["client_known"]), NOW), "keep");
});
