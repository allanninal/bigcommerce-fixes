import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPriceListRecords } from "./detect-price-list-webhook-gap.js";

const record = ({
  price_list_id = 1, variant_id = 100, price = "10.00", sale_price = "10.00",
  retail_price = "12.00", map_price = "", currency = "USD",
} = {}) => ({ price_list_id, variant_id, price, sale_price, retail_price, map_price, currency });

const CATALOG_ONLY = new Set(["store/product/updated", "store/sku/updated"]);
const CATALOG_AND_PRICE_LIST = new Set(["store/product/updated", "store/priceList/record/updated"]);

test("no findings when nothing changed", () => {
  const previous = { "1:100": record() };
  const current = { "1:100": record() };
  assert.deepEqual(diffPriceListRecords(previous, current, CATALOG_ONLY), []);
});

test("finds changed price and flags webhook gap when only catalog scopes watched", () => {
  const previous = { "1:100": record({ price: "10.00" }) };
  const current = { "1:100": record({ price: "12.00" }) };
  const findings = diffPriceListRecords(previous, current, CATALOG_ONLY);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].price_list_id, 1);
  assert.equal(findings[0].variant_id, 100);
  assert.deepEqual(findings[0].changed_fields, ["price"]);
  assert.equal(findings[0].webhook_gap, true);
});

test("no webhook gap when price list scope is also registered", () => {
  const previous = { "1:100": record({ price: "10.00" }) };
  const current = { "1:100": record({ price: "12.00" }) };
  const findings = diffPriceListRecords(previous, current, CATALOG_AND_PRICE_LIST);
  assert.equal(findings[0].webhook_gap, false);
});

test("no webhook gap when no catalog scopes are watched at all", () => {
  const previous = { "1:100": record({ price: "10.00" }) };
  const current = { "1:100": record({ price: "12.00" }) };
  const findings = diffPriceListRecords(previous, current, new Set());
  assert.equal(findings[0].webhook_gap, false);
});

test("new record counts as changed", () => {
  const previous = {};
  const current = { "2:200": record({ price_list_id: 2, variant_id: 200 }) };
  const findings = diffPriceListRecords(previous, current, CATALOG_ONLY);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].price_list_id, 2);
  assert.equal(findings[0].variant_id, 200);
});

test("multiple money fields are all reported", () => {
  const previous = { "1:100": record({ price: "10.00", sale_price: "9.00" }) };
  const current = { "1:100": record({ price: "12.00", sale_price: "11.00" }) };
  const findings = diffPriceListRecords(previous, current, CATALOG_ONLY);
  assert.deepEqual(new Set(findings[0].changed_fields), new Set(["price", "sale_price"]));
});

test("no findings when current is empty", () => {
  const previous = { "1:100": record() };
  const current = {};
  assert.deepEqual(diffPriceListRecords(previous, current, CATALOG_ONLY), []);
});

test("unchanged currency field does not trigger a finding", () => {
  const previous = { "1:100": record({ currency: "USD" }) };
  const current = { "1:100": record({ currency: "EUR" }) };
  assert.deepEqual(diffPriceListRecords(previous, current, CATALOG_ONLY), []);
});
