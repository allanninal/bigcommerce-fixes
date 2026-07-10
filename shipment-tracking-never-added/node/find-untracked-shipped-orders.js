/**
 * Flag BigCommerce orders marked Shipped that never got a real tracking number.
 *
 * POST /v2/orders/{id}/shipments only requires order_address_id and items.
 * tracking_number is optional, alongside tracking_link and shipping_provider.
 * That means the Ship Items modal in the control panel, or a connected OMS
 * or 3PL such as ShipStation, Cin7, or ShipHero, can create a shipment with
 * the Tracking ID box left blank, or an integration can move status_id
 * straight to 2 (Shipped) with PUT /v2/orders/{id} and skip shipment
 * creation entirely. Either way, the order looks fulfilled while the
 * customer has no way to track their package, and the automated shipping
 * confirmation email's tracking link points nowhere. This job lists orders
 * in status_id 2 (Shipped), 3 (Partially Shipped), and 10 (Completed), reads
 * each order's shipments, and flags only the ones older than a grace window
 * that have zero shipment records or whose shipments all carry empty
 * tracking_number, tracking_link, and shipping_provider fields. It never
 * fabricates a tracking number, it only leaves a note for a human to fill
 * in the real one. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/shipment-tracking-never-added/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SHIPPED_LIKE_STATUSES = new Set([2, 3, 10]); // Shipped, Partially Shipped, Completed

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function isBlank(value) {
  return !(value || "").trim();
}

/**
 * Pure decision. No network, no side effects.
 *
 * Considers only orders in status_id 2, 3, or 10, and only once
 * date_modified is older than graceHours, so an order the 3PL shipped
 * moments ago is not flagged before tracking has had a chance to post. An
 * order with an empty shipments list is flagged no_shipment_record. An
 * order whose shipments all have empty tracking_number, tracking_link, and
 * shipping_provider is flagged shipment_missing_tracking. Anything else is
 * left alone.
 */
export function findUntrackedShippedOrders(orders, shipmentsByOrderId, now, graceHours = 24) {
  const flagged = [];
  for (const order of orders) {
    if (!SHIPPED_LIKE_STATUSES.has(order.status_id)) continue;

    const modified = new Date(order.date_modified);
    const ageHours = (now.getTime() - modified.getTime()) / 3600000;
    if (ageHours < graceHours) continue;

    const shipments = shipmentsByOrderId.get(order.id) || [];
    if (shipments.length === 0) {
      flagged.push({ orderId: order.id, reason: "no_shipment_record" });
      continue;
    }

    const allMissingTracking = shipments.every(
      (s) => isBlank(s.tracking_number) && isBlank(s.tracking_link) && isBlank(s.shipping_provider)
    );
    if (allMissingTracking) {
      flagged.push({ orderId: order.id, reason: "shipment_missing_tracking" });
    }
  }
  return flagged;
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

async function* shippedLikeOrders() {
  for (const statusId of SHIPPED_LIKE_STATUSES) {
    let page = 1;
    while (true) {
      const orders = await bcGet("/orders", {
        status_id: statusId,
        min_date_modified: `-${LOOKBACK_DAYS} days`,
        page,
        limit: 250,
      });
      if (!orders.length) break;
      for (const order of orders) yield order;
      page += 1;
    }
  }
}

async function orderShipments(orderId) {
  return bcGet(`/orders/${orderId}/shipments`);
}

async function appendStaffNote(orderId, existingNotes, message) {
  const note = (existingNotes || "").trimEnd();
  const updated = note ? `${note}\n${message}`.trim() : message;
  return bcPut(`/orders/${orderId}`, { staff_notes: updated });
}

export async function run() {
  const now = new Date();
  const orders = [];
  for await (const order of shippedLikeOrders()) orders.push(order);

  const shipmentsByOrderId = new Map();
  for (const order of orders) {
    shipmentsByOrderId.set(order.id, await orderShipments(order.id));
  }

  const flagged = findUntrackedShippedOrders(orders, shipmentsByOrderId, now, GRACE_HOURS);

  for (const item of flagged) {
    console.warn(
      `order_id=${item.orderId} reason=${item.reason} ` +
      `${DRY_RUN ? "would flag with staff_notes" : "flagging with staff_notes"}`
    );
    if (!DRY_RUN) {
      const order = orders.find((o) => o.id === item.orderId) || {};
      const message = `ALERT: order marked Shipped on ${now.toISOString().slice(0, 10)} with no tracking number, verify with fulfillment.`;
      await appendStaffNote(item.orderId, order.staff_notes, message);
    }
  }

  console.log(`Done. ${flagged.length} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
