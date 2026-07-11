import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWebhookGap } from "./detect-webhook-gap.js";

const NOW = "2026-07-10T12:00:00Z";

const hook = ({ id = 1, scope = "store/order/statusUpdated", isActive = true, destination = "https://example.com/hooks" } = {}) => ({
  id, scope, destination, is_active: isActive, updated_at: NOW,
});

test("no findings when everything is current", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const log = { "store/order/statusUpdated": ["2026-07-10T11:56:00Z"] };
  assert.deepEqual(detectWebhookGap(orders, log, [hook()], NOW), []);
});

test("flags deactivated hook regardless of delivery log", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const log = { "store/order/statusUpdated": ["2026-07-10T11:56:00Z"] };
  const findings = detectWebhookGap(orders, log, [hook({ isActive: false })], NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "deactivated");
  assert.equal(findings[0].is_active, false);
});

test("flags stale active hook with no recent delivery", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const log = { "store/order/statusUpdated": ["2026-07-10T10:00:00Z"] };
  const findings = detectWebhookGap(orders, log, [hook()], NOW, 30);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "stale_no_recent_delivery");
});

test("no finding when gap is within stale threshold", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const log = { "store/order/statusUpdated": ["2026-07-10T11:45:00Z"] };
  assert.deepEqual(detectWebhookGap(orders, log, [hook()], NOW, 30), []);
});

test("ignores hooks outside order and customer scope", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const findings = detectWebhookGap(orders, {}, [hook({ scope: "store/product/updated", isActive: false })], NOW);
  assert.deepEqual(findings, []);
});

test("no findings when there are no orders at all", () => {
  assert.deepEqual(detectWebhookGap([], {}, [hook()], NOW), []);
});

test("flags customer scope hook too", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const findings = detectWebhookGap(orders, {}, [hook({ scope: "store/customer/created", isActive: false })], NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scope, "store/customer/created");
});

test("multiple hooks only flags the problem ones", () => {
  const orders = ["2026-07-10T11:55:00Z"];
  const log = {
    "store/order/statusUpdated": ["2026-07-10T11:56:00Z"],
    "store/order/created": ["2026-07-10T10:00:00Z"],
  };
  const hooks = [
    hook({ id: 1, scope: "store/order/statusUpdated", isActive: true }),
    hook({ id: 2, scope: "store/order/created", isActive: true }),
    hook({ id: 3, scope: "store/order/refunded", isActive: false }),
  ];
  const findings = detectWebhookGap(orders, log, hooks, NOW, 30);
  const ids = findings.map((f) => f.hook_id).sort();
  assert.deepEqual(ids, [2, 3]);
});
