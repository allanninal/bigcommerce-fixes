import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWebhookRequest } from "./verify-webhook-secret.js";

const hook = (over = {}) => ({ headers: { "X-Webhook-Secret": "correct-secret" }, ...over });

const incoming = (over = {}) => ({
  headers: { "X-Webhook-Secret": "correct-secret" },
  secretKeyName: "X-Webhook-Secret",
  mutationRanBeforeCheck: false,
  ...over,
});

test("unverifiable when hook has no headers", () => {
  assert.equal(classifyWebhookRequest({}, incoming()), "UNVERIFIABLE_NO_SECRET");
});

test("unverifiable when hook headers empty", () => {
  assert.equal(classifyWebhookRequest(hook({ headers: {} }), incoming()), "UNVERIFIABLE_NO_SECRET");
});

test("reject when header missing from request", () => {
  const req = incoming({ headers: {} });
  assert.equal(classifyWebhookRequest(hook(), req), "REJECT_MISMATCH");
});

test("reject when header value wrong", () => {
  const req = incoming({ headers: { "X-Webhook-Secret": "forged-value" } });
  assert.equal(classifyWebhookRequest(hook(), req), "REJECT_MISMATCH");
});

test("reject when mutation ran before check", () => {
  const req = incoming({ mutationRanBeforeCheck: true });
  assert.equal(classifyWebhookRequest(hook(), req), "REJECT_USED_BEFORE_CHECK");
});

test("trusted when match and checked first", () => {
  assert.equal(classifyWebhookRequest(hook(), incoming()), "TRUSTED");
});
