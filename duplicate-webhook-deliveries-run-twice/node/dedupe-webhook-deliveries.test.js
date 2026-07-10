import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWebhookDelivery } from "./dedupe-webhook-deliveries.js";

const payload = (over = {}) => ({
  scope: "store/order/updated", hash: "abc123", created_at: 1000, producer: "stores/abc", ...over,
});

test("new delivery is processed", () => {
  const result = classifyWebhookDelivery(payload(), new Set(), 1);
  assert.equal(result.action, "process");
});

test("same hash, created_at, scope, producer is a duplicate", () => {
  const first = classifyWebhookDelivery(payload(), new Set(), 1);
  const seen = new Set([first.deliveryId]);
  const second = classifyWebhookDelivery(payload(), seen, 1);
  assert.equal(second.deliveryId, first.deliveryId);
  assert.equal(second.action, "skip_duplicate");
});

test("different created_at is a new event", () => {
  // simulates the ~2s duplicate-fire case from rapid back-to-back admin edits
  const first = classifyWebhookDelivery(payload({ created_at: 1000 }), new Set(), 1);
  const seen = new Set([first.deliveryId]);
  const second = classifyWebhookDelivery(payload({ created_at: 1002 }), seen, 1);
  assert.notEqual(second.deliveryId, first.deliveryId);
  assert.equal(second.action, "process");
});

test("fanout flagged even if never seen before", () => {
  // two active hooks on the same scope + destination fan out one event into two deliveries
  const result = classifyWebhookDelivery(payload(), new Set(), 2);
  assert.equal(result.action, "flag_fanout");
});

test("fanout takes priority over duplicate check", () => {
  const first = classifyWebhookDelivery(payload(), new Set(), 1);
  const seen = new Set([first.deliveryId]);
  const second = classifyWebhookDelivery(payload(), seen, 2);
  assert.equal(second.action, "flag_fanout");
});

test("different scope is a different delivery", () => {
  const first = classifyWebhookDelivery(payload({ scope: "store/order/updated" }), new Set(), 1);
  const seen = new Set([first.deliveryId]);
  const second = classifyWebhookDelivery(payload({ scope: "store/product/updated" }), seen, 1);
  assert.notEqual(second.deliveryId, first.deliveryId);
  assert.equal(second.action, "process");
});
