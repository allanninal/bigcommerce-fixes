/**
 * Detect BigCommerce multi-address checkout consignment drift.
 *
 * Multi-address checkout represents each shipping destination as its own
 * consignment object holding its own line_items (item_id and quantity), and
 * the storefront or headless client is responsible for calling
 * assignItemsToAddress or unassignItemsToAddress (or POST/PUT
 * /checkouts/{id}/consignments) once per address as the shopper works
 * through the flow. Because these are sequential, independent calls against
 * a mutable checkout resource with optimistic concurrency version checks, a
 * slow network, a retried request, or a client that does not re-fetch
 * checkout state between calls can leave an item duplicated across
 * consignments or unassigned to any of them by the time the checkout
 * converts to an order. Once converted, each order line item is stamped
 * with a single order_address_id, so the drift becomes a permanent, silent
 * mismatch between what the customer intended per address and what the
 * order record shows.
 *
 * This job never repairs the mapping. It reports drift per product_id, and
 * for orders still Incomplete or Pending with unassigned quantity, it can
 * flag the order for manual verification (status_id 12) so a human reviews
 * it before it ships.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/multi-address-checkout-consignment-drift/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MANUAL_VERIFICATION_REQUIRED = 12;
const OPEN_STATUS_IDS = new Set([0, 1]); // Incomplete, Pending

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * consignments: pre-conversion checkout consignments, each
 *   { consignment_id, line_items: [{ item_id, quantity }], address_id }
 * orderProducts: post-conversion order line items from GET /v2/orders/{id}/products, each
 *   { id, product_id, quantity, order_address_id }
 *
 * Returns a list of drift records, one per product_id:
 *   { product_id, expected_qty, actual_qty, unassigned_qty, duplicated_qty, status }
 *
 * expectedQty is the sum of quantity across all consignment line_items for
 * that item_id (item_id maps 1:1 to product_id in this store's checkout
 * flow). actualQty is the sum of quantity across all orderProducts rows for
 * that product_id. unassignedQty is the portion of actualQty whose
 * order_address_id is 0 or null/undefined, meaning it was never bound to any
 * of the shipping addresses created for the order. duplicatedQty is
 * max(0, actualQty - expectedQty) when actualQty exceeds expectedQty. status
 * is "unassigned" if unassignedQty > 0, else "duplicated" if actualQty !==
 * expectedQty and duplicatedQty > 0, else "ok". Callers should pass only
 * physical line items in orderProducts so digital, non-shippable products
 * (order_address_id 0 by design) do not produce false positives.
 */
export function findConsignmentDrift(consignments, orderProducts) {
  const expectedQty = new Map();
  for (const consignment of consignments || []) {
    for (const lineItem of consignment.line_items || []) {
      const productId = lineItem.item_id;
      expectedQty.set(productId, (expectedQty.get(productId) || 0) + (lineItem.quantity || 0));
    }
  }

  const actualQty = new Map();
  const unassignedQty = new Map();
  for (const row of orderProducts || []) {
    const productId = row.product_id;
    const qty = row.quantity || 0;
    actualQty.set(productId, (actualQty.get(productId) || 0) + qty);

    const orderAddressId = row.order_address_id;
    if (orderAddressId === 0 || orderAddressId === null || orderAddressId === undefined) {
      unassignedQty.set(productId, (unassignedQty.get(productId) || 0) + qty);
    }
  }

  const productIds = new Set([...expectedQty.keys(), ...actualQty.keys()]);
  const drift = [];
  for (const productId of [...productIds].sort((a, b) => a - b)) {
    const expected = expectedQty.get(productId) || 0;
    const actual = actualQty.get(productId) || 0;
    const unassigned = unassignedQty.get(productId) || 0;
    const duplicated = actual > expected ? actual - expected : 0;

    let status = "ok";
    if (unassigned > 0) status = "unassigned";
    else if (actual !== expected && duplicated > 0) status = "duplicated";

    drift.push({
      product_id: productId,
      expected_qty: expected,
      actual_qty: actual,
      unassigned_qty: unassigned,
      duplicated_qty: duplicated,
      status,
    });
  }
  return drift;
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

async function bcPut(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* candidateOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGet(API_BASE_V2, "/orders", {
      min_date_created: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderShippingAddresses(orderId) {
  return bcGet(API_BASE_V2, `/orders/${orderId}/shipping_addresses`);
}

async function orderProducts(orderId) {
  return bcGet(API_BASE_V2, `/orders/${orderId}/products`);
}

async function checkoutConsignments(checkoutId) {
  const payload = await bcGet(API_BASE_V3, `/checkouts/${checkoutId}/consignments`);
  return Array.isArray(payload) ? payload : payload.data || [];
}

async function flagForManualVerification(orderId) {
  return bcPut(API_BASE_V2, `/orders/${orderId}`, { status_id: MANUAL_VERIFICATION_REQUIRED });
}

export async function run() {
  let reported = 0;
  let flagged = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const statusId = order.status_id;

    const addresses = await orderShippingAddresses(orderId);
    if (addresses.length < 2) continue; // not a multi-address order, nothing to reconcile

    const products = await orderProducts(orderId);
    const checkoutId = order.checkout_id;
    const consignments = checkoutId ? await checkoutConsignments(checkoutId) : [];

    const drift = findConsignmentDrift(consignments, products);
    const problems = drift.filter((d) => d.status !== "ok");
    if (!problems.length) continue;

    reported += 1;
    for (const record of problems) {
      console.warn(
        `order_id=${orderId} product_id=${record.product_id} status=${record.status} ` +
        `expected_qty=${record.expected_qty} actual_qty=${record.actual_qty} ` +
        `unassigned_qty=${record.unassigned_qty} duplicated_qty=${record.duplicated_qty}`
      );
    }

    const hasUnassigned = problems.some((d) => d.unassigned_qty > 0);
    if (hasUnassigned && OPEN_STATUS_IDS.has(statusId)) {
      console.log(
        `order_id=${orderId} eligible for manual verification flag (${DRY_RUN ? "dry run" : "flagging"})`
      );
      if (!DRY_RUN) await flagForManualVerification(orderId);
      flagged += 1;
    }
  }

  console.log(
    `Done. ${reported} order(s) with drift, ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"} for manual verification.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
