import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSplitRefundPayload } from "./refund-split-payment.js";

test("single tender refunds full amount to one provider", () => {
  const quote = { refund_methods: [{ provider_id: "gw_a", amount: "80.00" }] };
  assert.deepEqual(buildSplitRefundPayload(quote, "80.00"), [
    { provider_id: "gw_a", amount: "80.00" },
  ]);
});

test("multi tender splits across providers in order", () => {
  const quote = {
    refund_methods: [
      { provider_id: "gw_b", amount: "60.00" },
      { provider_id: "gw_a", amount: "20.00" },
    ],
  };
  assert.deepEqual(buildSplitRefundPayload(quote, "80.00"), [
    { provider_id: "gw_a", amount: "20.00" },
    { provider_id: "gw_b", amount: "60.00" },
  ]);
});

test("partial refund never exceeds a single method's max", () => {
  const quote = {
    refund_methods: [
      { provider_id: "gw_a", amount: "20.00" },
      { provider_id: "gw_b", amount: "60.00" },
    ],
  };
  assert.deepEqual(buildSplitRefundPayload(quote, "30.00"), [
    { provider_id: "gw_a", amount: "20.00" },
    { provider_id: "gw_b", amount: "10.00" },
  ]);
});

test("entries are ordered by provider_id even when quote is unordered", () => {
  const quote = {
    refund_methods: [
      { provider_id: "gw_z", amount: "5.00" },
      { provider_id: "gw_a", amount: "5.00" },
      { provider_id: "gw_m", amount: "5.00" },
    ],
  };
  const payload = buildSplitRefundPayload(quote, "15.00");
  assert.deepEqual(payload.map((p) => p.provider_id), ["gw_a", "gw_m", "gw_z"]);
});

test("amounts sum exactly to requested total", () => {
  const quote = {
    refund_methods: [
      { provider_id: "gw_a", amount: "33.33" },
      { provider_id: "gw_b", amount: "33.33" },
      { provider_id: "gw_c", amount: "33.34" },
    ],
  };
  const payload = buildSplitRefundPayload(quote, "100.00");
  const total = payload.reduce((sum, p) => sum + Number(p.amount), 0);
  assert.ok(Math.abs(total - 100) < 1e-9);
});

test("throws on over refund attempt", () => {
  const quote = { refund_methods: [{ provider_id: "gw_a", amount: "20.00" }] };
  assert.throws(() => buildSplitRefundPayload(quote, "20.01"));
});

test("throws on zero total", () => {
  const quote = { refund_methods: [{ provider_id: "gw_a", amount: "20.00" }] };
  assert.throws(() => buildSplitRefundPayload(quote, "0.00"));
});

test("throws on negative total", () => {
  const quote = { refund_methods: [{ provider_id: "gw_a", amount: "20.00" }] };
  assert.throws(() => buildSplitRefundPayload(quote, "-5.00"));
});

test("throws when refund_methods is empty", () => {
  assert.throws(() => buildSplitRefundPayload({ refund_methods: [] }, "10.00"));
});

test("throws when refund_methods key is missing", () => {
  assert.throws(() => buildSplitRefundPayload({}, "10.00"));
});
