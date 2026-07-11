import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLineItemOptionValue,
  OptionValueUnresolvedError,
} from "./normalize-line-item-options.js";

const CATALOG = [{ id: 42, label: "Red" }, { id: 43, label: "Blue" }];

test("free-input type passes literal text through", () => {
  const option = { type: "text", value: "Engrave: Happy Birthday", valueId: null, optionId: 9 };
  assert.deepEqual(normalizeLineItemOptionValue(option, []), {
    id: 9,
    value: "Engrave: Happy Birthday",
  });
});

test("null valueId passes literal text through even for choice type", () => {
  const option = { type: "dropdown", value: "Red", valueId: null, nameId: 5 };
  assert.deepEqual(normalizeLineItemOptionValue(option, CATALOG), { id: 5, value: "Red" });
});

test("numeric valueId resolves directly", () => {
  const option = { type: "dropdown", value: "Red", valueId: 42 };
  assert.deepEqual(normalizeLineItemOptionValue(option, CATALOG), { id: 42, value: "Red" });
});

test("string valueId coerces and resolves", () => {
  const option = { type: "swatch", value: "Blue", valueId: "43" };
  assert.deepEqual(normalizeLineItemOptionValue(option, CATALOG), { id: 43, value: "Blue" });
});

test("stale numeric id falls back to label match", () => {
  const option = { type: "dropdown", value: "Red", valueId: 999 };
  assert.deepEqual(normalizeLineItemOptionValue(option, CATALOG), { id: 42, value: "Red" });
});

test("unresolved id and label throws", () => {
  const option = { type: "dropdown", value: "Green", valueId: "not-an-id" };
  assert.throws(() => normalizeLineItemOptionValue(option, CATALOG), OptionValueUnresolvedError);
});

test("optionId preferred over nameId for free-input", () => {
  const option = { type: "file", value: "logo.png", valueId: null, optionId: 7, nameId: 5 };
  assert.equal(normalizeLineItemOptionValue(option, []).id, 7);
});

test("nameId used when optionId missing for free-input", () => {
  const option = { type: "date", value: "2026-07-10", valueId: null, nameId: 5 };
  assert.equal(normalizeLineItemOptionValue(option, []).id, 5);
});
