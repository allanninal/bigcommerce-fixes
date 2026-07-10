/**
 * Reconcile BigCommerce coupon usage counts against real completed orders.
 *
 * BigCommerce increments a coupon's num_uses on /v2/coupons the instant an
 * order is placed with that code applied. It never decrements it when the
 * order is later cancelled, declined, refunded, or manually edited or deleted,
 * because num_uses is documented as a read-only, system-maintained field that
 * cannot be corrected through a PUT or POST. The stored count drifts upward
 * relative to real usage until it collides with max_uses or
 * max_uses_per_customer and blocks a legitimate customer.
 *
 * This pages GET /v2/coupons for every coupon's reported num_uses, pages
 * GET /v2/orders plus GET /v2/orders/{id}/coupons to find every order that
 * ever carried each code, keeps only the orders whose status_id represents a
 * real completed or in-progress sale, and reconciles the two numbers with a
 * pure function. It never writes to num_uses. The default action is to flag
 * drifted coupons to a review queue. A destructive delete-and-recreate reset
 * is available only behind an explicit --confirm flag, off by default.
 * Guarded by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/coupon-usage-miscounts/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "dummy_store_hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const MIN_DATE_CREATED = process.env.MIN_DATE_CREATED || "";

const VALID_STATUS_IDS = new Set([2, 3, 7, 8, 9, 10, 11]);
// 2 Shipped, 3 Partially Shipped, 7 Awaiting Payment, 8 Awaiting Pickup,
// 9 Awaiting Shipment, 10 Completed, 11 Awaiting Fulfillment
// Excluded: 0 Incomplete, 5 Cancelled, 6 Declined, 4 Refunded, 14 Partially Refunded,
// 1 Pending, 12 Manual Verification Required, 13 Disputed

/**
 * coupon: {id, code, numUses}
 * ordersWithCoupon: [{orderId, statusId, couponCode}, ...] -- every order
 * found to reference this coupon code, regardless of status.
 * Pure, no I/O. Returns the reconciliation result for one coupon.
 */
export function reconcileCouponUsage(coupon, ordersWithCoupon, validStatusIds = VALID_STATUS_IDS, tolerance = 0) {
  const trueUses = ordersWithCoupon.filter((o) => validStatusIds.has(o.statusId)).length;
  const delta = coupon.numUses - trueUses;
  const offendingOrderIds = ordersWithCoupon
    .filter((o) => !validStatusIds.has(o.statusId))
    .map((o) => o.orderId)
    .sort((a, b) => a - b);

  return {
    couponId: coupon.id,
    code: coupon.code,
    reportedUses: coupon.numUses,
    trueUses,
    delta,
    drifted: delta > tolerance,
    offendingOrderIds,
  };
}

async function bc(method, path, body) {
  const res = await fetch(BASE + path.replace(/^\//, ""), {
    method,
    headers: { "X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function* allCoupons() {
  const limit = 250;
  let page = 1;
  while (true) {
    const batch = (await bc("GET", `/v2/coupons?limit=${limit}&page=${page}`)) || [];
    if (!batch.length) return;
    for (const coupon of batch) yield coupon;
    if (batch.length < limit) return;
    page += 1;
  }
}

async function* allOrders() {
  const limit = 250;
  let page = 1;
  while (true) {
    let qs = `limit=${limit}&page=${page}`;
    if (MIN_DATE_CREATED) qs += `&min_date_created=${MIN_DATE_CREATED}`;
    const batch = (await bc("GET", `/v2/orders?${qs}`)) || [];
    if (!batch.length) return;
    for (const order of batch) yield order;
    if (batch.length < limit) return;
    page += 1;
  }
}

async function orderCouponCodes(orderId) {
  const rows = (await bc("GET", `/v2/orders/${orderId}/coupons`)) || [];
  return rows.map((row) => row.code);
}

async function buildOrdersByCode() {
  const byCode = new Map();
  for await (const order of allOrders()) {
    const codes = await orderCouponCodes(order.id);
    for (const code of codes) {
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ orderId: order.id, statusId: order.status_id, couponCode: code });
    }
  }
  return byCode;
}

function flagForReview(result, reviewQueue) {
  // The only "write" the default flow performs: append to a review queue.
  // Never touches num_uses. reviewQueue is any append-only sink you control.
  reviewQueue.push({
    couponId: result.couponId,
    code: result.code,
    reportedUses: result.reportedUses,
    trueUses: result.trueUses,
    delta: result.delta,
    offendingOrderIds: result.offendingOrderIds,
  });
}

async function resetCouponDestructive(coupon) {
  // DELETE + POST to reset num_uses to 0. Destructive: usage history is lost
  // and cannot be seeded with the true count. Only called when --confirm is passed.
  await bc("DELETE", `/v2/coupons/${coupon.id}`);
  return bc("POST", "/v2/coupons", {
    code: coupon.code,
    type: coupon.type,
    amount: coupon.amount,
    max_uses: coupon.max_uses ?? null,
    expires: coupon.expires ?? null,
  });
}

export async function run(confirmReset = false) {
  const ordersByCode = await buildOrdersByCode();
  const reviewQueue = [];
  let driftedCount = 0;

  for await (const coupon of allCoupons()) {
    const ordersWithCoupon = ordersByCode.get(coupon.code) || [];
    const normalizedCoupon = { id: coupon.id, code: coupon.code, numUses: coupon.num_uses };
    const result = reconcileCouponUsage(normalizedCoupon, ordersWithCoupon);
    if (!result.drifted) continue;

    driftedCount++;
    console.warn(
      `Coupon "${result.code}" (id=${result.couponId}) reports ${result.reportedUses} uses, true usage is ${result.trueUses}, delta ${result.delta}. Offending orders: ${JSON.stringify(result.offendingOrderIds)}. ${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) flagForReview(result, reviewQueue);

    if (confirmReset && !DRY_RUN) {
      console.warn(`Resetting coupon "${result.code}" via delete and recreate. Usage history will reset to 0.`);
      await resetCouponDestructive(coupon);
    }
  }

  console.log(`Done. ${driftedCount} coupon(s) drifted, ${reviewQueue.length} flagged.`);
  return reviewQueue;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const confirm = process.argv.includes("--confirm");
  run(confirm).catch((err) => { console.error(err); process.exit(1); });
}
