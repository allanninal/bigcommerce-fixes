import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseOrderLinePricing } from "./diagnose-order-pricing.js";

test("not flagged when no price list assigned", () => {
  const result = diagnoseOrderLinePricing(null, null, null, "50.00", "50.00", 11, false);
  assert.equal(result.flagged, false);
  assert.equal(result.reason, "no_price_list_assigned");
  assert.equal(result.recommendedAction, "none");
});

test("not flagged when no price list record even with assignment", () => {
  const result = diagnoseOrderLinePricing(5, 9, null, "50.00", "50.00", 11, false);
  assert.equal(result.flagged, false);
  assert.equal(result.reason, "no_price_list_assigned");
});

test("not flagged when billed matches price list", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "40.00", 11, false);
  assert.equal(result.flagged, false);
  assert.equal(result.reason, "correctly_priced");
  assert.equal(result.recommendedAction, "none");
});

test("flagged when billed at catalog price ignoring pricelist", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "50.00", 11, false);
  assert.equal(result.flagged, true);
  assert.equal(result.reason, "billed_at_catalog_price_ignoring_pricelist");
  assert.equal(result.deltaExTax, "-10.00");
  assert.equal(result.recommendedAction, "cancel_unpaid");
});

test("recommends cancel_unpaid for status 0 incomplete", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "50.00", 0, false);
  assert.equal(result.recommendedAction, "cancel_unpaid");
});

test("recommends cancel_unpaid for status 7 awaiting payment", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "50.00", 7, false);
  assert.equal(result.recommendedAction, "cancel_unpaid");
});

test("recommends report_refund_delta when transaction captured", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "50.00", 11, true);
  assert.equal(result.flagged, true);
  assert.equal(result.recommendedAction, "report_refund_delta");
});

test("recommends report_refund_delta when order already shipped", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "50.00", 2, false);
  assert.equal(result.flagged, true);
  assert.equal(result.recommendedAction, "report_refund_delta");
});

test("recommends report_refund_delta for status 9 awaiting shipment even if unpaid", () => {
  // 9 (Awaiting Shipment) is not in the unpaid-cancellable set even though no
  // transaction was captured; it is outside {0, 7, 11}.
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "50.00", 9, false);
  assert.equal(result.flagged, true);
  assert.equal(result.recommendedAction, "report_refund_delta");
});

test("flagged billed price mismatch unknown source", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "45.00", 7, false);
  assert.equal(result.flagged, true);
  assert.equal(result.reason, "billed_price_mismatch_unknown_source");
  assert.equal(result.recommendedAction, "cancel_unpaid");
});

test("delta is positive when billed below list price", () => {
  const result = diagnoseOrderLinePricing(5, 9, "40.00", "50.00", "35.00", 7, false);
  assert.equal(result.flagged, true);
  assert.equal(result.deltaExTax, "5.00");
});
