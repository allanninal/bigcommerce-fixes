import { test } from "node:test";
import assert from "node:assert/strict";
import { planWebhookReconciliation } from "./reconcile-webhooks.js";

const desiredEntry = (over = {}) => ({
  scope: "store/order/created",
  destination: "https://app.example.com/hooks",
  is_active: true,
  headers: {},
  ...over,
});

const liveHook = (id, over = {}) => ({
  id,
  scope: "store/order/created",
  destination: "https://app.example.com/hooks",
  is_active: true,
  ...over,
});

test("healthy hook is left alone", () => {
  const plan = planWebhookReconciliation([desiredEntry()], [liveHook(1)]);
  assert.deepEqual(plan, { toReactivate: [], toRecreate: [], toLeave: [1] });
});

test("inactive hook goes to reactivate", () => {
  const plan = planWebhookReconciliation([desiredEntry()], [liveHook(1, { is_active: false })]);
  assert.deepEqual(plan.toReactivate, [1]);
  assert.deepEqual(plan.toRecreate, []);
  assert.deepEqual(plan.toLeave, []);
});

test("missing hook goes to recreate", () => {
  const plan = planWebhookReconciliation([desiredEntry()], []);
  assert.deepEqual(plan.toRecreate, [desiredEntry()]);
  assert.deepEqual(plan.toReactivate, []);
  assert.deepEqual(plan.toLeave, []);
});

test("mixed manifest preserves desired order", () => {
  const desired = [
    desiredEntry({ scope: "store/order/created" }),
    desiredEntry({ scope: "store/product/updated" }),
    desiredEntry({ scope: "store/cart/abandoned" }),
  ];
  const live = [
    liveHook(1, { scope: "store/order/created", is_active: true }),
    liveHook(2, { scope: "store/product/updated", is_active: false }),
  ];
  const plan = planWebhookReconciliation(desired, live);
  assert.deepEqual(plan.toLeave, [1]);
  assert.deepEqual(plan.toReactivate, [2]);
  assert.deepEqual(plan.toRecreate, [desiredEntry({ scope: "store/cart/abandoned" })]);
});

test("does not mutate inputs", () => {
  const desired = [desiredEntry()];
  const live = [liveHook(1, { is_active: false })];
  const desiredCopy = JSON.parse(JSON.stringify(desired));
  const liveCopy = JSON.parse(JSON.stringify(live));
  planWebhookReconciliation(desired, live);
  assert.deepEqual(desired, desiredCopy);
  assert.deepEqual(live, liveCopy);
});

test("different destination same scope counts as missing", () => {
  const plan = planWebhookReconciliation(
    [desiredEntry({ destination: "https://app.example.com/new-hooks" })],
    [liveHook(1, { destination: "https://app.example.com/old-hooks" })],
  );
  assert.deepEqual(plan.toRecreate, [desiredEntry({ destination: "https://app.example.com/new-hooks" })]);
  assert.deepEqual(plan.toReactivate, []);
  assert.deepEqual(plan.toLeave, []);
});

test("empty desired yields all empty buckets", () => {
  const plan = planWebhookReconciliation([], [liveHook(1)]);
  assert.deepEqual(plan, { toReactivate: [], toRecreate: [], toLeave: [] });
});
