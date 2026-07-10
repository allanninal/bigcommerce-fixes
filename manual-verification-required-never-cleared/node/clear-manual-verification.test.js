import { test } from "node:test";
import assert from "node:assert/strict";
import { decideClearable } from "./clear-manual-verification.js";

const order = (over = {}) => ({ status_id: 12, staff_notes: "", date_modified: "2026-07-01T10:00:00Z", ...over });
const msg = (text, createdAt = "2026-07-02T10:00:00Z") => ({ message: text, date_created: createdAt });

test("skip when not status 12", () => {
  assert.equal(decideClearable(order({ status_id: 11 }), [], "captured"), "skip");
});

test("hold when transaction declined", () => {
  assert.equal(decideClearable(order({ staff_notes: "Approved by Jane" }), [], "declined"), "hold");
});

test("hold when transaction void", () => {
  assert.equal(decideClearable(order({ staff_notes: "Cleared by Jane" }), [], "void"), "hold");
});

test("hold when no approval marker", () => {
  assert.equal(decideClearable(order(), [], "captured"), "hold");
});

test("clear when staff_notes has marker and transaction ok", () => {
  assert.equal(decideClearable(order({ staff_notes: "Verified by Jane on review" }), [], "captured"), "clear");
});

test("clear when message marker after date_modified", () => {
  assert.equal(decideClearable(order(), [msg("Approved after review")], "approved"), "clear");
});

test("hold when message marker before date_modified", () => {
  const result = decideClearable(
    order({ date_modified: "2026-07-05T10:00:00Z" }),
    [msg("Approved earlier", "2026-07-01T09:00:00Z")],
    "captured",
  );
  assert.equal(result, "hold");
});

test("clear when transaction status is null", () => {
  assert.equal(decideClearable(order({ staff_notes: "Cleared by Jane" }), [], null), "clear");
});

test("skip takes priority over declined transaction", () => {
  assert.equal(decideClearable(order({ status_id: 6 }), [], "declined"), "skip");
});

test("marker is case insensitive", () => {
  assert.equal(decideClearable(order({ staff_notes: "VERIFIED by Jane" }), [], "captured"), "clear");
});
