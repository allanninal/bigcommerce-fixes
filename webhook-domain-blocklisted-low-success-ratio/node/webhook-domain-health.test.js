import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWebhookHealth } from "./webhook-domain-health.js";

function makeRequests(domain, total, failures) {
  const entries = [];
  for (let i = 0; i < total; i++) {
    const status = i < failures ? 500 : 200;
    entries.push({ timestamp: i, domain, status_code: status });
  }
  return entries;
}

test("domain below sample size is not evaluated", () => {
  const result = evaluateWebhookHealth(makeRequests("shop-a.example.com", 40, 40));
  const entry = result["shop-a.example.com"];
  assert.equal(entry.total, 40);
  assert.equal(entry.success_ratio, null);
  assert.equal(entry.at_risk, false);
});

test("domain at or above sample with low ratio is at risk", () => {
  const result = evaluateWebhookHealth(makeRequests("shop-b.example.com", 100, 15));
  const entry = result["shop-b.example.com"];
  assert.equal(entry.total, 100);
  assert.equal(entry.success_ratio, 0.85);
  assert.equal(entry.at_risk, true);
});

test("domain at sample with healthy ratio is not at risk", () => {
  const result = evaluateWebhookHealth(makeRequests("shop-c.example.com", 120, 5));
  const entry = result["shop-c.example.com"];
  assert.equal(entry.total, 120);
  assert.equal(
    Math.round(entry.success_ratio * 10000) / 10000,
    Math.round(((120 - 5) / 120) * 10000) / 10000
  );
  assert.equal(entry.at_risk, false);
});

test("ratio exactly at threshold is not at risk", () => {
  const result = evaluateWebhookHealth(makeRequests("shop-d.example.com", 100, 10));
  const entry = result["shop-d.example.com"];
  assert.equal(entry.success_ratio, 0.90);
  assert.equal(entry.at_risk, false);
});

test("ratio just below threshold is at risk", () => {
  const result = evaluateWebhookHealth(makeRequests("shop-e.example.com", 100, 11));
  const entry = result["shop-e.example.com"];
  assert.equal(entry.success_ratio, 0.89);
  assert.equal(entry.at_risk, true);
});

test("multiple domains are evaluated independently", () => {
  const healthy = makeRequests("healthy.example.com", 100, 2);
  const flaky = makeRequests("flaky.example.com", 150, 40);
  const result = evaluateWebhookHealth([...healthy, ...flaky]);
  assert.equal(result["healthy.example.com"].at_risk, false);
  assert.equal(result["flaky.example.com"].at_risk, true);
});

test("empty input returns empty object", () => {
  assert.deepEqual(evaluateWebhookHealth([]), {});
});

test("custom min sample and threshold are respected", () => {
  const result = evaluateWebhookHealth(makeRequests("custom.example.com", 20, 5), 10, 0.80);
  const entry = result["custom.example.com"];
  assert.equal(entry.total, 20);
  assert.equal(entry.success_ratio, 0.75);
  assert.equal(entry.at_risk, true);
});
