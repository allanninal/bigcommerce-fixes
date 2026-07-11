import { test } from "node:test";
import assert from "node:assert/strict";
import { planRedirects } from "./repair-deleted-url-redirects.js";

const FALLBACK = { type: "url", url: "/" };

test("no plan when nothing deleted", () => {
  const previous = { 1: "/old-widget/" };
  assert.deepEqual(planRedirects(previous, new Set([1]), new Set(), FALLBACK), []);
});

test("plans a redirect for a deleted uncovered url", () => {
  const previous = { 1: "/old-widget/", 2: "/old-gadget/" };
  const plan = planRedirects(previous, new Set([2]), new Set(), FALLBACK);
  assert.deepEqual(plan, [{ from_path: "/old-widget/", to: FALLBACK }]);
});

test("skips a deleted url already covered by a redirect", () => {
  const previous = { 1: "/old-widget/" };
  const plan = planRedirects(previous, new Set(), new Set(["/old-widget/"]), FALLBACK);
  assert.deepEqual(plan, []);
});

test("handles multiple deletions independently", () => {
  const previous = { 1: "/old-widget/", 2: "/old-gadget/", 3: "/old-gizmo/" };
  const plan = planRedirects(previous, new Set(), new Set(["/old-gadget/"]), FALLBACK);
  const fromPaths = new Set(plan.map((item) => item.from_path));
  assert.deepEqual(fromPaths, new Set(["/old-widget/", "/old-gizmo/"]));
});

test("empty previous snapshot yields empty plan", () => {
  assert.deepEqual(planRedirects({}, new Set([1, 2, 3]), new Set(), FALLBACK), []);
});

test("id still live is never included even if url changed", () => {
  const previous = { 1: "/old-widget/" };
  const plan = planRedirects(previous, new Set([1]), new Set(), FALLBACK);
  assert.deepEqual(plan, []);
});

test("fallback target passed through unmodified", () => {
  const previous = { 1: "/old-widget/" };
  const customFallback = { type: "category", entity_id: 42 };
  const plan = planRedirects(previous, new Set(), new Set(), customFallback);
  assert.deepEqual(plan, [{ from_path: "/old-widget/", to: customFallback }]);
});
