/**
 * Flag BigCommerce orders where a manually overridden line-item price
 * silently excluded the order from an active, matching automatic promotion.
 *
 * BigCommerce's pricing engine only evaluates promotions against catalog or
 * price-list-derived prices computed by its own pricing service. When a line
 * item is created with an explicit price_ex_tax or price_inc_tax override,
 * through the V2 Orders API's server-to-server order creation or the
 * Cart/Checkout Server-to-Server APIs, that price is a manually set custom
 * price, not a catalog price. By default, automatic and coupon promotions
 * skip line items with custom pricing. A store-level setting, "Allow
 * promotions to apply on products with custom price overrides" under
 * Settings, Promotions and coupons, has to be turned on before the promotion
 * engine will consider those line items. Leave it off, the default, and any
 * order built through a price-override integration silently gets $0 promo
 * discount even when an active, matching automatic promotion exists.
 *
 * This is not safely auto-fixable as a write against a settled order, so the
 * default action is flag and report, never a direct discount rewrite.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/overridden-order-pricing-excludes-promotions/
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const V2_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const V3_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPORT_PATH = process.env.REPORT_PATH || "promo_override_report.json";

// Shipped, Partially Shipped, Refunded, Completed, Partially Refunded.
// Always report-only, never rewritten.
const ALWAYS_SKIP_STATUS_IDS = new Set([2, 3, 4, 10, 14]);
// Incomplete, Awaiting Payment. Eligible for a guarded, opt-in repair.
const PRE_CAPTURE_STATUS_IDS = new Set([0, 7]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision logic (no I/O) -- inputs are plain objects/arrays already
 * fetched from GET /v2/orders/{id}, GET /v2/orders/{id}/products,
 * GET /v2/orders/{id}/coupons, and GET /v3/promotions?status=ENABLED.
 *
 * order: {id, discount_amount, coupon_discount, subtotal_ex_tax,
 *         base_total_ex_tax, customer_group_id, date_created}
 * lineItems: [{product_id, price_ex_tax, base_price, applied_discounts: [...]}]
 * orderCoupons: [] or [{code, amount, type}]
 * activePromotions: [{id, redemption_type, rules: [...], current_days_and_times: {...}}]
 *
 * Returns null if no discrepancy, else a flag object:
 *   {order_id, reason, has_price_override, expected_promo_ids}
 */
export function flagMissingPromotion(order, lineItems, orderCoupons, activePromotions) {
  const hasPriceOverride = (lineItems || []).some(
    (li) =>
      li.price_ex_tax !== undefined && li.price_ex_tax !== null
      && li.base_price !== undefined && li.base_price !== null
      && li.price_ex_tax !== li.base_price
  );
  const noDiscountRecorded = (
    Number.parseFloat(order.discount_amount || "0") === 0
    && Number.parseFloat(order.coupon_discount || "0") === 0
    && (orderCoupons || []).length === 0
    && !(lineItems || []).some((li) => li.applied_discounts && li.applied_discounts.length)
  );

  if (!(hasPriceOverride && noDiscountRecorded)) return null;

  const eligiblePromoIds = (activePromotions || [])
    .filter((p) => p.redemption_type === "AUTOMATIC")
    .map((p) => p.id);
  if (!eligiblePromoIds.length) return null;

  return {
    order_id: order.id,
    reason: "price_override_excluded_from_active_automatic_promotion",
    has_price_override: hasPriceOverride,
    expected_promo_ids: eligiblePromoIds,
  };
}

export function recommendedAction(orderStatusId) {
  if (ALWAYS_SKIP_STATUS_IDS.has(orderStatusId)) return "flag_only_settled_order";
  if (PRE_CAPTURE_STATUS_IDS.has(orderStatusId)) return "flag_or_guarded_repair_pre_capture";
  return "flag_only";
}

export function overrideAmount(order, lineItems) {
  let total = 0;
  for (const li of lineItems || []) {
    const priceOverride = li.price_ex_tax;
    const basePrice = li.base_price;
    if (priceOverride !== undefined && priceOverride !== null && basePrice !== undefined && basePrice !== null && priceOverride !== basePrice) {
      const diff = Math.abs(Number.parseFloat(priceOverride) - Number.parseFloat(basePrice));
      if (Number.isFinite(diff)) total += diff;
    }
  }
  return Math.round(total * 100) / 100;
}

async function bcGet(base, path, params = {}) {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function* candidateOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGet(V2_BASE, "/orders", {
      min_date_created: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderLineItems(orderId) {
  return bcGet(V2_BASE, `/orders/${orderId}/products`);
}

async function orderCoupons(orderId) {
  return bcGet(V2_BASE, `/orders/${orderId}/coupons`);
}

async function activeAutomaticPromotions() {
  const resp = await bcGet(V3_BASE, "/promotions", { status: "ENABLED" });
  return Array.isArray(resp) ? resp : resp.data || [];
}

function writeReport(rows, path) {
  writeFileSync(path, JSON.stringify(rows, null, 2));
  if (path.endsWith(".json")) {
    const csvPath = path.slice(0, -".json".length) + ".csv";
    const header = "order_id,expected_promo_ids,override_amount,recommended_action\n";
    const lines = rows.map(
      (r) => `${r.order_id},"${r.expected_promo_ids.join(";")}",${r.override_amount},${r.recommended_action}`
    );
    writeFileSync(csvPath, header + lines.join("\n") + (lines.length ? "\n" : ""));
  }
}

export async function run() {
  const activePromotions = await activeAutomaticPromotions();
  const reportRows = [];

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const lineItems = await orderLineItems(orderId);
    const coupons = await orderCoupons(orderId);

    const flag = flagMissingPromotion(order, lineItems, coupons, activePromotions);
    if (!flag) continue;

    const statusId = order.status_id;
    const action = recommendedAction(statusId);
    const row = {
      order_id: orderId,
      expected_promo_ids: flag.expected_promo_ids,
      override_amount: overrideAmount(order, lineItems),
      recommended_action: action,
    };
    reportRows.push(row);
    console.warn(
      `order_id=${orderId} status_id=${statusId} override_amount=${row.override_amount} ` +
      `expected_promo_ids=${flag.expected_promo_ids.join(",")} action=${action} ` +
      `(${DRY_RUN ? "dry run, report only" : "reported, no write performed"})`
    );
  }

  writeReport(reportRows, REPORT_PATH);
  console.log(`Done. ${reportRows.length} order(s) flagged. Report written to ${REPORT_PATH}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
