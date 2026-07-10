import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBackfillAction, needsBackfill } from "./backfill-order-metadata.js";

const NOW = "2026-07-10T00:00:00.000Z";

const order = (over = {}) => ({
  status_id: 10, staff_notes: "", external_id: "", external_merchant_id: "", ...over,
});

test("skips incomplete order", () => {
  const result = decideBackfillAction(order({ status_id: 0 }), null, NOW);
  assert.deepEqual(result, { action: "skip", reason: "incomplete_or_voided" });
});

test("skips cancelled order even with a confident match", () => {
  const result = decideBackfillAction(order({ status_id: 5 }), { external_id: "X", confidence: 0.9 }, NOW);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "incomplete_or_voided");
});

test("skips declined order", () => {
  const result = decideBackfillAction(order({ status_id: 6 }), null, NOW);
  assert.deepEqual(result, { action: "skip", reason: "incomplete_or_voided" });
});

test("skips already tagged order", () => {
  const result = decideBackfillAction(order({ staff_notes: "prior note\n[RECON:UNMATCHED;checked=x]" }), null, NOW);
  assert.deepEqual(result, { action: "skip", reason: "already_tagged" });
});

test("skips order with existing external_id", () => {
  const result = decideBackfillAction(order({ external_id: "ERP-1" }), { external_id: "ERP-1", confidence: 0.95 }, NOW);
  assert.deepEqual(result, { action: "skip", reason: "already_has_external_key" });
});

test("skips order with existing external_merchant_id", () => {
  const result = decideBackfillAction(order({ external_merchant_id: "MERCH-1" }), null, NOW);
  assert.deepEqual(result, { action: "skip", reason: "already_has_external_key" });
});

test("flags unmatched when no candidate", () => {
  const result = decideBackfillAction(order(), null, NOW);
  assert.equal(result.action, "flag_unmatched");
  assert.equal(result.new_staff_notes, `\n[RECON:UNMATCHED;checked=${NOW}]`);
});

test("flags unmatched when confidence is low", () => {
  const result = decideBackfillAction(order(), { external_id: "ERP-1", confidence: 0.4 }, NOW);
  assert.equal(result.action, "flag_unmatched");
});

test("flags unmatched just below threshold", () => {
  const result = decideBackfillAction(order(), { external_id: "ERP-1", confidence: 0.79 }, NOW);
  assert.equal(result.action, "flag_unmatched");
});

test("writes staff notes when confident", () => {
  const candidate = { external_id: "ERP-00219482", source: "M-MIG", confidence: 0.92 };
  const result = decideBackfillAction(order(), candidate, NOW);
  assert.equal(result.action, "write_staff_notes");
  assert.equal(result.new_staff_notes, `\n[RECON:ext_id=ERP-00219482;source=M-MIG;matched=${NOW}]`);
});

test("writes staff notes at exact threshold", () => {
  const candidate = { external_id: "ERP-2", source: "M-MIG", confidence: 0.8 };
  const result = decideBackfillAction(order(), candidate, NOW);
  assert.equal(result.action, "write_staff_notes");
});

test("defaults source to M-MIG when missing", () => {
  const candidate = { external_id: "ERP-3", confidence: 0.85 };
  const result = decideBackfillAction(order(), candidate, NOW);
  assert.ok(result.new_staff_notes.includes("source=M-MIG"));
});

test("appends rather than overwrites existing notes", () => {
  const candidate = { external_id: "ERP-9", source: "M-MIG", confidence: 0.85 };
  const result = decideBackfillAction(order({ staff_notes: "called customer 2026-01-02" }), candidate, NOW);
  assert.ok(result.new_staff_notes.startsWith("called customer 2026-01-02\n[RECON:"));
});

test("needsBackfill is false when external_id present", () => {
  assert.equal(needsBackfill({ external_id: "ERP-1" }), false);
});

test("needsBackfill is false when external_merchant_id present", () => {
  assert.equal(needsBackfill({ external_merchant_id: "M-1" }), false);
});

test("needsBackfill is false when external_source is an expected tag", () => {
  assert.equal(needsBackfill({ external_source: "M-MIG" }), false);
});

test("needsBackfill is true when everything is missing", () => {
  assert.equal(needsBackfill({}), true);
});
