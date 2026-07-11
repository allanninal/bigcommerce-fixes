/**
 * Find BigCommerce order shipments whose items array was dropped by a mapper.
 *
 * BigCommerce's V2 shipment object, from GET /v2/orders/{order_id}/shipments,
 * nests the shipped order lines inside an items array of order_product_id,
 * product_id, and quantity, alongside flat scalar fields like tracking_number
 * and order_address_id. Client integrations that map the response through a
 * fixed schema, a typed model or DTO, or a column-style allowlist built for
 * the common scalar fields can easily leave items out, since it is a nested
 * array and not a top-level scalar. The mapped object then shows items as
 * missing, null, or an empty list even though the raw JSON body still has the
 * shipped lines. This is a client-side parsing defect, not corrupted
 * BigCommerce data, so this job never writes to the shipment. It only
 * reports the drift and, when DRY_RUN is false, cross-checks the raw shipped
 * quantities against GET /v2/orders/{order_id}/products to confirm the
 * shipped lines are real.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-shipments-missing-items-array/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Stand-in for a narrow scalar-only mapper that omits the nested items array.
// Replace this with your real SDK/DTO mapping when wiring this into your own
// integration; the point of the reconciler is to compare THAT output against
// the raw JSON body BigCommerce actually sent.
const SCALAR_FIELDS = [
  "id", "order_id", "customer_id", "order_address_id",
  "date_created", "tracking_number", "shipping_provider",
  "tracking_carrier", "comments",
];

/**
 * Pure decision logic, no I/O.
 *
 * rawShipment: parsed JSON body of a single V2 shipment as returned by
 *              GET /stores/{store_hash}/v2/orders/{order_id}/shipments/{shipment_id}
 * mappedShipment: the same shipment after passing through the client
 *              library/ORM mapper (dict-like view of its attributes)
 * Returns a drift record if the mapper dropped/emptied a non-empty raw
 * 'items' array, else null.
 */
export function findItemsDrift(rawShipment, mappedShipment) {
  const rawItems = rawShipment.items || [];
  const mappedItems = mappedShipment.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null; // nothing shipped in raw; not a drift case
  }
  const mappedIsEmptyOrInvalid =
    mappedItems == null ||
    !Array.isArray(mappedItems) ||
    mappedItems.length === 0;
  if (mappedIsEmptyOrInvalid) {
    const rawQty = rawItems.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    return {
      shipmentId: rawShipment.id,
      orderId: rawShipment.order_id,
      rawItemCount: rawItems.length,
      rawShippedQuantity: rawQty,
      mappedItemsValue: mappedItems,
      orderProductIds: rawItems.map((i) => i.order_product_id),
    };
  }
  return null;
}

async function bcGetRaw(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function orderShipments(orderId) {
  return bcGetRaw(`/orders/${orderId}/shipments`);
}

async function orderProducts(orderId) {
  return bcGetRaw(`/orders/${orderId}/products`);
}

function mapShipmentScalarsOnly(rawShipment) {
  const mapped = {};
  for (const key of SCALAR_FIELDS) mapped[key] = rawShipment[key];
  return mapped;
}

async function crossCheckQuantityShipped(orderId, orderProductIds) {
  const products = await orderProducts(orderId);
  const byId = new Map(products.map((p) => [p.id, p.quantity_shipped]));
  const result = {};
  for (const opid of orderProductIds) result[opid] = byId.get(opid);
  return result;
}

export async function run(orderIds) {
  let driftCount = 0;

  for (const orderId of orderIds) {
    const rawShipments = await orderShipments(orderId);
    for (const rawShipment of rawShipments || []) {
      const mappedShipment = mapShipmentScalarsOnly(rawShipment);
      const drift = findItemsDrift(rawShipment, mappedShipment);
      if (drift === null) continue;

      driftCount += 1;
      console.warn(
        `Drift found: shipment_id=${drift.shipmentId} order_id=${drift.orderId} ` +
        `raw_item_count=${drift.rawItemCount} raw_shipped_quantity=${drift.rawShippedQuantity} ` +
        `mapped_items_value=${JSON.stringify(drift.mappedItemsValue)}`
      );

      if (!DRY_RUN) {
        const confirmed = await crossCheckQuantityShipped(orderId, drift.orderProductIds);
        console.log(
          `Cross-check for shipment_id=${drift.shipmentId} order_id=${drift.orderId} ` +
          `quantity_shipped=${JSON.stringify(confirmed)}`
        );
      }
    }
  }

  console.log(`Done. ${driftCount} shipment(s) with dropped items array.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const orderIdsEnv = process.env.ORDER_IDS || "";
  const orderIds = orderIdsEnv.split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  run(orderIds).catch((err) => { console.error(err); process.exit(1); });
}
