/**
 * Flag BigCommerce orders with a physical line item but no shipping address.
 *
 * BigCommerce only writes a shipping_addresses record on an order when the cart
 * that produced it contained at least one line item whose product type is
 * physical. An order made up entirely of digital line items, downloads,
 * services, or gift certificates never gets one, and GET
 * /v2/orders/{id}/shipping_addresses legitimately returns an empty array for
 * that order. That is expected behavior, not a bug. The real anomaly is a
 * physical line item with no address on file, most often caused by a custom or
 * headless checkout integration that created the order via the API and skipped
 * submitting consignments. This job audits a list of orders, resolves each line
 * item's product type, and flags only the orders where a physical item shipped
 * with no shipping address and the order is in a real post-checkout status.
 * There is no API to retroactively attach a real shipping address, so the only
 * write action is a staff_notes annotation, guarded by DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-missing-shipping-address-no-physical-item/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EXCLUDED_STATUS_IDS = new Set([0, 5, 6]);
const FLAG_NOTE = "missing shipping address - needs manual review";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Takes the order's statusId, a list of each line item's resolved product
 * type string ("physical"/"digital"), and whether shipping_addresses was
 * non-empty. Returns one of:
 *
 *   ok_digital_only        - no physical items, no address expected.
 *   ok_has_address          - shipping_addresses is non-empty.
 *   ok_excluded_status      - statusId in {0, 5, 6}, absence is inconclusive.
 *   anomaly_missing_address - post-checkout status, a physical item is
 *                             present, and no shipping address exists.
 */
export function classifyShippingAddressGap(statusId, lineItemTypes, hasShippingAddress) {
  if (EXCLUDED_STATUS_IDS.has(statusId)) return "ok_excluded_status";

  if (hasShippingAddress) return "ok_has_address";

  const hasPhysicalItem = (lineItemTypes || []).some((t) => t === "physical");
  if (!hasPhysicalItem) return "ok_digital_only";

  return "anomaly_missing_address";
}

async function bcGetV2(path, params = {}) {
  const url = new URL(`${API_V2}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcGetV3(path, params = {}) {
  const url = new URL(`${API_V3}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const body = await res.json();
  return body.data !== undefined ? body.data : body;
}

async function bcPutV2(path, body) {
  const res = await fetch(`${API_V2}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* ordersToAudit() {
  let page = 1;
  while (true) {
    const orders = await bcGetV2("/orders", {
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
  return bcGetV2(`/orders/${orderId}/products`);
}

async function orderShippingAddresses(orderId) {
  return bcGetV2(`/orders/${orderId}/shipping_addresses`);
}

async function resolveProductType(productId, cache) {
  if (cache.has(productId)) return cache.get(productId);
  let value = "physical";
  try {
    const product = await bcGetV3(`/catalog/products/${productId}`);
    value = product.type || "physical";
  } catch {
    // A deleted or inaccessible product is treated as physical, the
    // conservative choice, so a real anomaly is never silently dropped.
    value = "physical";
  }
  cache.set(productId, value);
  return value;
}

async function flagOrderForReview(orderId, existingNotes = "") {
  const notes = (existingNotes || "").trim();
  if (notes.includes(FLAG_NOTE)) return null;
  const merged = notes ? `${notes}\n${FLAG_NOTE}`.trim() : FLAG_NOTE;
  return bcPutV2(`/orders/${orderId}`, { staff_notes: merged });
}

export async function run() {
  const productTypeCache = new Map();
  let anomalies = 0;
  let digitalOnly = 0;

  for await (const order of ordersToAudit()) {
    const orderId = order.id;
    const statusId = order.status_id;

    const lineItems = await orderLineItems(orderId);
    const productIds = [...new Set((lineItems || []).map((item) => item.product_id).filter(Boolean))].sort(
      (a, b) => a - b
    );
    const lineItemTypes = [];
    for (const pid of productIds) {
      lineItemTypes.push(await resolveProductType(pid, productTypeCache));
    }

    const shippingAddresses = await orderShippingAddresses(orderId);
    const hasShippingAddress = Boolean(shippingAddresses && shippingAddresses.length);

    const classification = classifyShippingAddressGap(statusId, lineItemTypes, hasShippingAddress);

    if (classification === "ok_digital_only") {
      digitalOnly += 1;
      console.log(`order_id=${orderId} status_id=${statusId} ok_digital_only (no address expected)`);
      continue;
    }

    if (classification !== "anomaly_missing_address") continue;

    const physicalProductIds = productIds.filter((pid, i) => lineItemTypes[i] === "physical");
    const customerId = order.customer_id;

    console.warn(
      `anomaly_missing_address order_id=${orderId} status_id=${statusId} ` +
      `physical_product_ids=${JSON.stringify(physicalProductIds)} customer_id=${customerId} ` +
      `(${DRY_RUN ? "dry run" : "flagging"})`
    );
    if (!DRY_RUN) await flagOrderForReview(orderId, order.staff_notes || "");
    anomalies += 1;
  }

  console.log(
    `Done. ${anomalies} anomaly(ies) found, ${digitalOnly} digital-only order(s) logged for visibility.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
