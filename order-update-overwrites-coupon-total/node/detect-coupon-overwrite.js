/**
 * Detect BigCommerce orders whose coupon discount was silently recalculated away.
 *
 * BigCommerce's V2 Orders API treats coupon_discount as a read-only, server-derived
 * value, calculated from the /v2/orders/{id}/coupons sub-resource and each line
 * item's applied_discounts, not stored as an independently editable field on the
 * order record. When a PUT to /v2/orders/{id} changes any total-affecting property,
 * line items, subtotal_ex_tax/subtotal_inc_tax, total_ex_tax/total_inc_tax, shipping,
 * handling, wrapping, or fees, BigCommerce recalculates the subtotal and total
 * fields from the current line items and cost fields, and per BigCommerce's own
 * documentation the PUT request clears all discounts and promotions applied to the
 * changed order line items. Because there is no writable coupon_discount field to
 * resend, a PUT aimed at an unrelated field can silently zero out or shrink a
 * previously applied coupon discount. This job diffs each modified order against a
 * stored known-good snapshot and the live coupons sub-resource, and reports the
 * orders where the discount no longer reconciles. Report only by default.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-update-overwrites-coupon-total/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ALLOW_WRITE = (process.env.ALLOW_WRITE || "false").toLowerCase() === "true";

const RECONCILE_TOLERANCE = 0.99;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * snapshot/live = {orderId, couponDiscount, totalIncTax, totalExTax, dateModified}
 * activeCoupons = list of {code, discount, type}
 *
 * expectedDiscount = sum of every active coupon's discount. If there is no
 * active discount expected, or the live couponDiscount did not drop below the
 * snapshot, or nothing has actually changed (same dateModified), the order is
 * not corrupted. Otherwise, compare how much the total actually fell against
 * how much the coupon discount alone should account for. If the total fell by
 * meaningfully less than the expected discount, the discount was recalculated
 * away rather than legitimately superseded by an unrelated line-item change,
 * so the order is flagged as corrupted with the missing delta.
 */
export function detectCouponOverwrite(snapshot, live, activeCoupons) {
  const expectedDiscount = activeCoupons.reduce((sum, c) => sum + c.discount, 0);

  const result = {
    orderId: live.orderId,
    isCorrupted: false,
    expectedDiscount,
    observedDiscount: live.couponDiscount,
    deltaMissing: 0,
  };

  if (expectedDiscount <= 0) return result;
  if (live.couponDiscount >= snapshot.couponDiscount) return result;
  if (live.dateModified === snapshot.dateModified) return result;

  const delta = snapshot.totalIncTax - live.totalIncTax;

  if (delta < expectedDiscount * RECONCILE_TOLERANCE) {
    result.isCorrupted = true;
    result.deltaMissing = expectedDiscount - (snapshot.couponDiscount - live.couponDiscount);
  }

  return result;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* modifiedOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGet("/orders", {
      min_date_modified: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 250,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderCoupons(orderId) {
  return bcGet(`/orders/${orderId}/coupons`);
}

function loadSnapshot(_orderId) {
  // Placeholder for your local snapshot store, keyed by order id, recorded at
  // the last known-good state (e.g. right after the store/order/created
  // webhook). Replace with a real database or file lookup.
  return null;
}

async function reapplyKnownGoodTotals(orderId, totalExTax, totalIncTax) {
  // Only ever called under an explicit --allow-write flag, never by default.
  return bcPut(`/orders/${orderId}`, {
    total_ex_tax: String(totalExTax),
    total_inc_tax: String(totalIncTax),
  });
}

export async function run(allowWrite = ALLOW_WRITE) {
  let flagged = 0;
  let checked = 0;

  for await (const order of modifiedOrders()) {
    const orderId = order.id;
    const snapshot = loadSnapshot(orderId);
    if (!snapshot) continue;

    checked += 1;
    const coupons = await orderCoupons(orderId);
    const activeCoupons = (coupons || []).map((c) => ({
      code: c.code,
      discount: Number.parseFloat(c.discount || "0"),
      type: c.type,
    }));

    const live = {
      orderId,
      couponDiscount: Number.parseFloat(order.coupon_discount || "0"),
      totalIncTax: Number.parseFloat(order.total_inc_tax || "0"),
      totalExTax: Number.parseFloat(order.total_ex_tax || "0"),
      dateModified: order.date_modified,
    };

    const result = detectCouponOverwrite(snapshot, live, activeCoupons);

    if (!result.isCorrupted) continue;

    const codes = activeCoupons.map((c) => c.code).filter(Boolean).join(", ");
    console.warn(
      `order_id=${orderId} coupon overwrite detected. expected_discount=${result.expectedDiscount} ` +
      `observed_discount=${result.observedDiscount} delta_missing=${result.deltaMissing} coupons=${codes}`
    );
    flagged += 1;

    if (allowWrite && !DRY_RUN) {
      await reapplyKnownGoodTotals(orderId, snapshot.totalExTax, snapshot.totalIncTax);
      const confirm = await bcGet(`/orders/${orderId}`);
      const confirmed = Number.parseFloat(confirm.coupon_discount || "0") >= snapshot.couponDiscount;
      console.log(`order_id=${orderId} reconciled=${confirmed}`);
    }
  }

  console.log(`Done. ${checked} order(s) checked, ${flagged} order(s) flagged for a wiped coupon discount.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
