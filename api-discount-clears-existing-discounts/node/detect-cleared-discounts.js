/**
 * Detect BigCommerce checkouts where an API discount call cleared existing discounts.
 *
 * POST /v3/checkouts/{checkoutId}/discounts treats manual discounts as a full
 * replacement set, not an additive list. Per BigCommerce's own documentation,
 * calling this endpoint clears out all existing discounts applied to line
 * items, including product- and order-based discounts. A script or integration
 * that posts a new API discount to add a promo therefore silently wipes any
 * coupon discount, automatic promotion, or prior manual discount already
 * reflected on the cart or order, with no merge and no warning in the response
 * body. Because checkout discounts operate on the pre-order checkout resource,
 * not the immutable /v2/orders/{id}, the loss happens upstream of order
 * creation, so the placed order already reflects the wrong total with no audit
 * trail pointing to the call that caused it.
 *
 * This job snapshots a checkout's discount and coupon state before and after
 * any discount POST, diffs the two snapshots with a pure, decimal-safe
 * function, and emits a DRY_RUN guarded report for every affected checkout. It
 * never silently re-applies a merged discount list, because the original
 * coupon's validity window, usage counters, and tax recalculation cannot be
 * reliably reconstructed client-side.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/api-discount-clears-existing-discounts/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function toMinorUnits(value) {
  const str = String(value ?? "0");
  const [wholeRaw, fracRaw = ""] = str.split(".");
  const sign = wholeRaw.startsWith("-") ? -1n : 1n;
  const whole = wholeRaw.replace("-", "") || "0";
  const frac = (fracRaw + "00").slice(0, 2) || "00";
  return sign * (BigInt(whole) * 100n + BigInt(frac));
}

function formatMinorUnits(minor) {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * Pure comparison of two snapshot objects. No I/O.
 *
 * before / after shape: {discountIds: string[], couponCodes: string[],
 * totalDiscountedAmount: string}.
 *
 * Computes the set difference of discountIds and couponCodes, before minus
 * after, and totalDelta using decimal-safe subtraction on minor units rather
 * than float parsing, since money is a decimal string. isAffected is true
 * when either lost list is non-empty.
 */
export function diffDiscountState(before, after) {
  const afterDiscountIds = new Set(after.discountIds || []);
  const afterCouponCodes = new Set(after.couponCodes || []);

  const lostDiscountIds = (before.discountIds || []).filter((id) => !afterDiscountIds.has(id));
  const lostCouponCodes = (before.couponCodes || []).filter((code) => !afterCouponCodes.has(code));

  const beforeMinor = toMinorUnits(before.totalDiscountedAmount);
  const afterMinor = toMinorUnits(after.totalDiscountedAmount);
  const totalDelta = formatMinorUnits(beforeMinor - afterMinor);

  const isAffected = lostDiscountIds.length > 0 || lostCouponCodes.length > 0;

  return {
    lostDiscountIds,
    lostCouponCodes,
    totalDelta,
    isAffected,
  };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function snapshotCheckoutDiscountState(checkoutId) {
  const checkout = await bcGet(`/checkouts/${checkoutId}`);
  const couponsResp = await bcGet(`/checkouts/${checkoutId}/coupons`);

  const data = checkout.data || {};
  const cart = data.cart || {};
  const discountIds = (cart.discounts || []).map((d) => String(d.id));
  const couponCodes = (couponsResp.data || []).map((c) => c.code).filter(Boolean);
  const grandTotal = String(data.grand_total ?? "0");

  return {
    discountIds,
    couponCodes,
    totalDiscountedAmount: grandTotal,
  };
}

async function applyDiscount(checkoutId, discounts) {
  return bcPost(`/checkouts/${checkoutId}/discounts`, { discounts });
}

function buildAffectedReport(checkoutId, cartId, orderId, before, after, diff) {
  return {
    checkout_id: checkoutId,
    cart_id: cartId,
    order_id_if_created: orderId,
    discounts_before: before.discountIds,
    coupons_before: before.couponCodes,
    discounts_after: after.discountIds,
    coupons_after: after.couponCodes,
    total_delta: diff.totalDelta,
  };
}

async function checkCheckout(checkoutId, cartId, newDiscounts, orderId = null) {
  const before = await snapshotCheckoutDiscountState(checkoutId);

  if (DRY_RUN) {
    console.log(`DRY_RUN: would POST discounts ${JSON.stringify(newDiscounts)} to checkout ${checkoutId}`);
  } else {
    await applyDiscount(checkoutId, newDiscounts);
  }

  const after = await snapshotCheckoutDiscountState(checkoutId);
  const diff = diffDiscountState(before, after);

  if (!diff.isAffected) return null;

  const report = buildAffectedReport(checkoutId, cartId, orderId, before, after, diff);
  console.warn(
    `Checkout ${checkoutId} affected. lost_discount_ids=${JSON.stringify(diff.lostDiscountIds)} ` +
    `lost_coupon_codes=${JSON.stringify(diff.lostCouponCodes)} total_delta=${diff.totalDelta}`
  );
  return report;
}

export async function run(checkoutId, cartId, newDiscounts, orderId = null) {
  const report = await checkCheckout(checkoutId, cartId, newDiscounts, orderId);
  if (report === null) {
    console.log(`Checkout ${checkoutId}: no discounts or coupons lost.`);
  } else {
    console.log("Affected checkout report:", report);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkoutId = process.env.CHECKOUT_ID || "";
  const cartId = process.env.CART_ID || "";
  if (checkoutId && cartId) {
    run(checkoutId, cartId, [{ discount_type: "manual", amount: "10.00" }]).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    console.log("Set CHECKOUT_ID and CART_ID to run this against a real checkout.");
  }
}
