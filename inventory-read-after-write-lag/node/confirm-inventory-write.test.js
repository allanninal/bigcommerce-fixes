import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmInventoryWrite } from "./confirm-inventory-write.js";

test("confirmed when observed matches expected", () => {
  const result = confirmInventoryWrite(50, 50, "adj_1", 0, 6);
  assert.equal(result.status, "confirmed");
});

test("stale_flagged when adjustment id missing", () => {
  const result = confirmInventoryWrite(50, 40, null, 0, 6);
  assert.equal(result.status, "stale_flagged");
  assert.equal(result.reason, "missing action id, cannot confirm");
});

test("retry when not matching and budget remains", () => {
  const result = confirmInventoryWrite(50, 40, "adj_1", 0, 6);
  assert.equal(result.status, "retry");
  assert.equal(result.nextDelayS, 1.0);
});

test("retry delay doubles each attempt", () => {
  const result = confirmInventoryWrite(50, 40, "adj_1", 2, 6);
  assert.equal(result.nextDelayS, 4.0);
});

test("retry delay caps at max delay", () => {
  const result = confirmInventoryWrite(50, 40, "adj_1", 10, 20, 1.0, 60.0);
  assert.equal(result.nextDelayS, 60.0);
});

test("stale_flagged when budget exhausted", () => {
  const result = confirmInventoryWrite(50, 40, "adj_1", 6, 6);
  assert.equal(result.status, "stale_flagged");
  assert.equal(result.reason, "poll budget exhausted");
});

test("confirmed takes priority even at final attempt", () => {
  const result = confirmInventoryWrite(50, 50, "adj_1", 6, 6);
  assert.equal(result.status, "confirmed");
});

test("zero expected quantity can confirm", () => {
  const result = confirmInventoryWrite(0, 0, "adj_1", 0, 6);
  assert.equal(result.status, "confirmed");
});

test("undefined adjustment id is treated as missing", () => {
  const result = confirmInventoryWrite(50, 40, undefined, 0, 6);
  assert.equal(result.status, "stale_flagged");
});
