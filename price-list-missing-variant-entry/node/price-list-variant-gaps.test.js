import { test } from "node:test";
import assert from "node:assert/strict";
import { findVariantPriceGaps } from "./price-list-variant-gaps.js";

test("variant present in both shows no gap", () => {
  const activeVariantIds = new Set([1, 2]);
  const records = [{ variant_id: 1 }, { variant_id: 2 }];
  const groupToPriceList = { 10: 500 };
  assert.deepEqual(findVariantPriceGaps(activeVariantIds, records, groupToPriceList), []);
});

test("variant missing from records is reported", () => {
  const activeVariantIds = new Set([1, 2, 3]);
  const records = [{ variant_id: 1 }, { variant_id: 2 }];
  const groupToPriceList = { 10: 500 };
  const result = findVariantPriceGaps(activeVariantIds, records, groupToPriceList);
  assert.deepEqual(result, [
    { price_list_id: 500, variant_id: 3, affected_customer_groups: [10] },
  ]);
});

test("multiple groups on same price list are all listed", () => {
  const activeVariantIds = new Set([3]);
  const records = [];
  const groupToPriceList = { 10: 500, 20: 500 };
  const result = findVariantPriceGaps(activeVariantIds, records, groupToPriceList);
  assert.equal(result.length, 1);
  assert.deepEqual(new Set(result[0].affected_customer_groups), new Set([10, 20]));
});

test("results are sorted by variant_id", () => {
  const activeVariantIds = new Set([3, 1, 2]);
  const records = [];
  const groupToPriceList = { 10: 500 };
  const result = findVariantPriceGaps(activeVariantIds, records, groupToPriceList);
  assert.deepEqual(result.map((r) => r.variant_id), [1, 2, 3]);
});

test("no gaps when no active variants", () => {
  assert.deepEqual(findVariantPriceGaps(new Set(), [], { 10: 500 }), []);
});

test("gap reported separately per distinct price list", () => {
  const activeVariantIds = new Set([7]);
  const records = [];
  const groupToPriceList = { 10: 500, 20: 600 };
  const result = findVariantPriceGaps(activeVariantIds, records, groupToPriceList);
  const priceListIds = new Set(result.map((r) => r.price_list_id));
  assert.deepEqual(priceListIds, new Set([500, 600]));
});

test("no gap reported for price lists with no group assignment", () => {
  const activeVariantIds = new Set([1, 2]);
  const records = [];
  const groupToPriceList = {};
  assert.deepEqual(findVariantPriceGaps(activeVariantIds, records, groupToPriceList), []);
});
