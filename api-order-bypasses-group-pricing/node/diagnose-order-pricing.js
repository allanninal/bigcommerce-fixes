/**
 * Flag BigCommerce orders created via API that bypassed group and price list pricing.
 *
 * POST /v2/orders is a back-office order-entry endpoint, not the storefront checkout
 * pricing engine. It only runs a cart through the pricing service if the caller omits
 * price fields entirely. When an integration supplies price_inc_tax/price_ex_tax on
 * each line, exactly what "pre-resolving" price client-side produces, BigCommerce
 * takes that number as authoritative and never resolves it against the customer's
 * assigned Price List or customer-group discount rules. Because the order has no
 * cart_id tying it back to a priced cart, there is no signal the submitted price is
 * stale or wrong. This job scans recent orders, resolves each customer's assigned
 * price list, and flags any line billed at plain catalog price (or any other price)
 * when the price list disagrees. It never rewrites a placed order's price fields; it
 * only cancels an unpaid order with no captured transaction, or reports a delta for a
 * human to refund or credit. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/api-order-bypasses-group-pricing/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const V2_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const V3_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const CHANNEL_ID = Number(process.env.CHANNEL_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const UNPAID_STATUS_IDS = new Set([0, 7, 11]);
const API_CREATION_WINDOW_STATUS_IDS = new Set([0, 7, 9, 11]);
const CANCELLED = 5;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision logic, no I/O. All prices passed as decimal strings, compared as numbers.
 *
 * Returns { flagged, reason, deltaExTax, recommendedAction }.
 * If assignedPriceListId or priceListRecordPriceExTax is null: not flagged, the customer
 * has no price-list override, plain catalog price is correct.
 * If billedPriceExTax === priceListRecordPriceExTax: not flagged, correctly priced.
 * If billedPriceExTax === catalogPriceExTax and the price list disagrees with catalog:
 * flagged, reason 'billed_at_catalog_price_ignoring_pricelist'.
 * Otherwise: flagged, reason 'billed_price_mismatch_unknown_source'.
 * recommendedAction is 'cancel_unpaid' when orderStatusId is in {0, 7, 11} and there is
 * no captured transaction, else 'report_refund_delta'.
 */
export function diagnoseOrderLinePricing(
  customerGroupId,
  assignedPriceListId,
  priceListRecordPriceExTax,
  catalogPriceExTax,
  billedPriceExTax,
  orderStatusId,
  hasCapturedTransaction
) {
  if (assignedPriceListId == null || priceListRecordPriceExTax == null) {
    return { flagged: false, reason: "no_price_list_assigned", deltaExTax: "0", recommendedAction: "none" };
  }

  const listPrice = Number.parseFloat(priceListRecordPriceExTax);
  const billed = Number.parseFloat(billedPriceExTax);
  const catalog = Number.parseFloat(catalogPriceExTax);

  if (!Number.isFinite(listPrice) || !Number.isFinite(billed) || !Number.isFinite(catalog)) {
    return {
      flagged: true,
      reason: "billed_price_mismatch_unknown_source",
      deltaExTax: "0",
      recommendedAction: "report_refund_delta",
    };
  }

  if (billed === listPrice) {
    return { flagged: false, reason: "correctly_priced", deltaExTax: "0", recommendedAction: "none" };
  }

  const unpaid = UNPAID_STATUS_IDS.has(orderStatusId) && !hasCapturedTransaction;
  const action = unpaid ? "cancel_unpaid" : "report_refund_delta";

  if (billed === catalog && listPrice !== catalog) {
    return {
      flagged: true,
      reason: "billed_at_catalog_price_ignoring_pricelist",
      deltaExTax: (listPrice - billed).toFixed(2),
      recommendedAction: action,
    };
  }

  return {
    flagged: true,
    reason: "billed_price_mismatch_unknown_source",
    deltaExTax: (listPrice - billed).toFixed(2),
    recommendedAction: action,
  };
}

async function bcGetV2(path, params = {}) {
  const url = new URL(`${V2_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcPutV2(path, body) {
  const res = await fetch(`${V2_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcGetV3(path, params = {}) {
  const url = new URL(`${V3_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : { data: [] };
}

async function* candidateOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGetV2("/orders", {
      min_date_created: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) {
      if (API_CREATION_WINDOW_STATUS_IDS.has(order.status_id)) yield order;
    }
    page += 1;
  }
}

async function orderProducts(orderId) {
  return bcGetV2(`/orders/${orderId}/products`);
}

async function orderHasCapturedTransaction(orderId) {
  const transactions = await bcGetV2(`/orders/${orderId}/transactions`);
  for (const txn of transactions || []) {
    const kind = (txn.type || txn.event || "").toLowerCase();
    const status = (txn.status || "").toLowerCase();
    if ((kind === "capture" || kind === "sale") && status === "success") return true;
  }
  return false;
}

async function customerGroupId(customerId) {
  if (!customerId) return null;
  const data = await bcGetV3("/customers", { "id:in": customerId });
  const rows = data.data || [];
  return rows.length ? rows[0].customer_group_id : null;
}

async function assignedPriceListId(customerGroupIdValue) {
  if (!customerGroupIdValue) return null;
  const data = await bcGetV3("/pricelists/assignments", {
    customer_group_id: customerGroupIdValue,
    channel_id: CHANNEL_ID,
  });
  const rows = data.data || [];
  return rows.length ? rows[0].price_list_id : null;
}

async function priceListRecordPrice(priceListId, variantId) {
  if (!priceListId) return null;
  const data = await bcGetV3(`/pricelists/${priceListId}/records`, { "variant_id:in": variantId });
  const rows = data.data || [];
  return rows.length ? rows[0].price_ex_tax : null;
}

async function catalogVariantPrice(productId, variantId) {
  const data = await bcGetV3(`/catalog/products/${productId}/variants/${variantId}`);
  const row = data.data || {};
  return row.price != null ? String(row.price) : null;
}

export async function run() {
  let flaggedCount = 0;
  let cancelledCount = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const customerId = order.customer_id;
    const statusId = order.status_id;

    const groupId = await customerGroupId(customerId);
    const priceListId = await assignedPriceListId(groupId);

    if (priceListId == null) continue;

    const hasCaptured = await orderHasCapturedTransaction(orderId);
    const lines = await orderProducts(orderId);

    for (const line of lines || []) {
      const productId = line.product_id;
      const variantId = line.variant_id;
      const billed = line.price_ex_tax;

      const listPrice = await priceListRecordPrice(priceListId, variantId);
      const catalogPrice = await catalogVariantPrice(productId, variantId);

      const result = diagnoseOrderLinePricing(
        groupId, priceListId, listPrice, catalogPrice, billed, statusId, hasCaptured
      );

      if (!result.flagged) continue;

      flaggedCount += 1;
      console.warn(
        `order_id=${orderId} product_id=${productId} variant_id=${variantId} billed=${billed} ` +
        `list_price=${listPrice} catalog_price=${catalogPrice} reason=${result.reason} ` +
        `delta=${result.deltaExTax} action=${result.recommendedAction}`
      );

      if (result.recommendedAction === "cancel_unpaid") {
        if (!DRY_RUN) await bcPutV2(`/orders/${orderId}`, { status_id: CANCELLED });
        cancelledCount += 1;
      }
    }
  }

  console.log(
    `Done. ${flaggedCount} line(s) flagged, ${cancelledCount} order(s) ${DRY_RUN ? "to cancel" : "cancelled"} for cancellation.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
