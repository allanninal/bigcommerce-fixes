import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCurrencyVariance } from "./find-currency-variance.js";

const order = (over = {}) => ({
  defaultCurrencyCode: "EUR",
  storeDefaultCurrencyCode: "USD",
  totalIncTax: "100.00",
  storeDefaultToTransactionalExchangeRate: "0.90",
  ledgerBaseAmount: "90.00",
  ...over,
});

test("same currency is never a mismatch", () => {
  const result = classifyCurrencyVariance(
    order({ defaultCurrencyCode: "USD", storeDefaultCurrencyCode: "USD", ledgerBaseAmount: "100.00" })
  );
  assert.equal(result.isMismatch, false);
});

test("matching conversion within tolerance", () => {
  const result = classifyCurrencyVariance(order());
  assert.equal(result.isMismatch, false);
  assert.equal(result.expectedBaseAmount, 90);
  assert.equal(result.variance, 0);
});

test("flags variance beyond tolerance", () => {
  const result = classifyCurrencyVariance(order({ ledgerBaseAmount: "85.00" }));
  assert.equal(result.isMismatch, true);
  assert.equal(Number(result.varianceRatio.toFixed(4)), Number((5 / 90).toFixed(4)));
});

test("within tolerance ratio is not flagged", () => {
  const result = classifyCurrencyVariance(order({ ledgerBaseAmount: "89.70" }));
  assert.equal(result.isMismatch, false);
});

test("custom tolerance ratio", () => {
  const result = classifyCurrencyVariance(order({ ledgerBaseAmount: "89.00" }), 0.001);
  assert.equal(result.isMismatch, true);
});

test("presentment and settlement currency reported", () => {
  const result = classifyCurrencyVariance(order({ ledgerBaseAmount: "85.00" }));
  assert.equal(result.presentmentCurrency, "EUR");
  assert.equal(result.settlementCurrency, "USD");
});

test("zero total does not divide by zero", () => {
  const result = classifyCurrencyVariance(
    order({ totalIncTax: "0", storeDefaultToTransactionalExchangeRate: "0.90", ledgerBaseAmount: "0" })
  );
  assert.equal(result.expectedBaseAmount, 0);
  assert.equal(result.varianceRatio, 0);
  assert.equal(result.isMismatch, false);
});
