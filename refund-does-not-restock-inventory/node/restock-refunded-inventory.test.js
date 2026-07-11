import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRestockAdjustments } from "./restock-refunded-inventory.js";

const refundLine = ({
  refund_item_id = "r1:100", order_id = 1, product_id = 100, variant_id = null, quantity = 2,
} = {}) => ({ refund_item_id, order_id, product_id, variant_id, quantity });

test("restocks an unreconciled unflagged line", () => {
  const result = computeRestockAdjustments([refundLine()], new Set(), {});
  assert.deepEqual(result, [{
    product_id: 100, variant_id: null, adjustment: 2,
    refund_item_id: "r1:100", order_id: 1,
  }]);
});

test("skips a line already in the ledger", () => {
  const result = computeRestockAdjustments([refundLine()], new Set(["r1:100"]), {});
  assert.deepEqual(result, []);
});

test("skips a line flagged non-restockable", () => {
  const result = computeRestockAdjustments([refundLine()], new Set(), { "r1:100": true });
  assert.deepEqual(result, []);
});

test("skips a line with zero or negative quantity", () => {
  const zero = computeRestockAdjustments([refundLine({ quantity: 0 })], new Set(), {});
  assert.deepEqual(zero, []);

  const negative = computeRestockAdjustments([refundLine({ quantity: -3 })], new Set(), {});
  assert.deepEqual(negative, []);
});

test("handles multiple lines independently", () => {
  const lines = [
    refundLine({ refund_item_id: "r1:100", product_id: 100, quantity: 2 }),
    refundLine({ refund_item_id: "r1:200", product_id: 200, quantity: 1 }),
  ];
  const result = computeRestockAdjustments(lines, new Set(["r1:200"]), {});
  assert.equal(result.length, 1);
  assert.equal(result[0].product_id, 100);
  assert.equal(result[0].adjustment, 2);
});

test("preserves variant_id when present", () => {
  const result = computeRestockAdjustments([refundLine({ variant_id: 555 })], new Set(), {});
  assert.equal(result[0].variant_id, 555);
});

test("returns empty array when there are no refunded lines", () => {
  const result = computeRestockAdjustments([], new Set(), {});
  assert.deepEqual(result, []);
});

test("passes through refund_item_id and order_id", () => {
  const result = computeRestockAdjustments(
    [refundLine({ refund_item_id: "r9:42", order_id: 77, product_id: 42, quantity: 3 })],
    new Set(),
    {}
  );
  assert.equal(result[0].refund_item_id, "r9:42");
  assert.equal(result[0].order_id, 77);
});
