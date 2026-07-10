import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySkuConflicts } from "./find-sku-conflicts.js";

const record = (id, sku, parentProductId = null) => ({ id, sku, parentProductId });

test("no conflicts when all unique", () => {
  const records = [record(1, "ABC-1"), record(2, "ABC-2"), record(3, "ABC-3")];
  const result = classifySkuConflicts(records);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.missing, []);
});

test("detects duplicate case and whitespace insensitive", () => {
  const records = [record(1, "ABC-1"), record(2, "  abc-1  "), record(3, "ABC-2")];
  const result = classifySkuConflicts(records);
  assert.deepEqual(result.duplicates, [{ normalizedSku: "abc-1", recordIds: [1, 2] }]);
});

test("detects missing sku for null, blank, and whitespace", () => {
  const records = [record(1, null), record(2, ""), record(3, "   "), record(4, "ABC-9")];
  const result = classifySkuConflicts(records);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.missing, [
    { id: 1, parentProductId: null },
    { id: 2, parentProductId: null },
    { id: 3, parentProductId: null },
  ]);
});

test("missing keeps parentProductId for variants", () => {
  const records = [record(55, null, 10)];
  const result = classifySkuConflicts(records);
  assert.deepEqual(result.missing, [{ id: 55, parentProductId: 10 }]);
});

test("duplicates sorted by normalizedSku and missing by id", () => {
  const records = [
    record(3, null),
    record(1, null),
    record(9, "zzz-1"),
    record(8, "zzz-1"),
    record(6, "aaa-1"),
    record(5, "aaa-1"),
  ];
  const result = classifySkuConflicts(records);
  assert.deepEqual(result.duplicates.map((d) => d.normalizedSku), ["aaa-1", "zzz-1"]);
  assert.deepEqual(result.missing.map((m) => m.id), [1, 3]);
});

test("three way duplicate groups all ids", () => {
  const records = [record(1, "DUP-1"), record(2, "DUP-1"), record(3, "DUP-1")];
  const result = classifySkuConflicts(records);
  assert.deepEqual(result.duplicates, [{ normalizedSku: "dup-1", recordIds: [1, 2, 3] }]);
});
