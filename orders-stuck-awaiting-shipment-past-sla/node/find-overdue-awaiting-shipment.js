/**
 * Flag BigCommerce orders stuck Awaiting Shipment past a shipping SLA.
 *
 * BigCommerce moves a paid order into status_id 11 (Awaiting Fulfillment)
 * automatically once payment captures, and merchants or OMS integrations
 * move it to status_id 9 (Awaiting Shipment) once picked and packed.
 * Neither status has a built-in SLA clock or aging alert, so an order only
 * leaves Awaiting Shipment when someone explicitly posts a shipment. Orders
 * age silently past a shipping promise whenever a warehouse task is missed,
 * a 3PL or OMS sync fails, or the store/order/statusUpdated webhook that
 * would have notified an external fulfillment system was auto-deactivated
 * by BigCommerce after repeated non-2xx responses and never recreated. This
 * job lists orders in status_id 9, 11, and 8, confirms each candidate's
 * payment actually settled and that no shipment already exists, computes
 * how far past the SLA it is, and flags only the genuinely overdue ones
 * with a note on staff_notes. It never marks an order shipped and never
 * fabricates a shipment record. Run on a schedule. Safe to run again and
 * again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/orders-stuck-awaiting-shipment-past-sla/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const SLA_HOURS = Number(process.env.SLA_HOURS || 48);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CANDIDATE_STATUSES = [9, 11, 8]; // Awaiting Shipment, Awaiting Fulfillment, Awaiting Pickup
const TARGET_STATUS_IDS = new Set([9, 11]);
const SETTLED_TRANSACTION_TYPES = new Set(["capture", "settled", "sale"]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

export function hasCapturedPayment(transactions) {
  return (transactions || []).some((t) => SETTLED_TRANSACTION_TYPES.has((t.type || "").toLowerCase()));
}

/**
 * Pure decision. No network, no side effects.
 *
 * Filters orders down to status_id 9 or 11 (or a caller-supplied set),
 * excludes any order that already has a shipment (the status just has not
 * synced yet) or whose payment is not captured (guards against Awaiting
 * Payment or a declined order masquerading under the wrong status_id),
 * computes ageHours from date_created, and keeps only the orders older
 * than slaHours. Returns overdue orders sorted by overageHours descending,
 * so the worst breaches surface first.
 */
export function findOverdueOrders(orders, now, slaHours, targetStatusIds = TARGET_STATUS_IDS) {
  const overdue = [];
  for (const order of orders) {
    if (!targetStatusIds.has(order.status_id)) continue;
    if (order.has_shipment) continue;
    if (order.payment_status !== "captured") continue;

    const created = new Date(order.date_created);
    const ageHours = (now.getTime() - created.getTime()) / 3600000;

    if (ageHours > slaHours) {
      overdue.push({
        orderId: order.id,
        statusId: order.status_id,
        dateCreated: created,
        ageHours,
        overageHours: ageHours - slaHours,
      });
    }
  }

  overdue.sort((a, b) => b.overageHours - a.overageHours);
  return overdue;
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

async function* candidateOrders() {
  for (const statusId of CANDIDATE_STATUSES) {
    let page = 1;
    while (true) {
      const orders = await bcGet("/orders", { status_id: statusId, page, limit: 250 });
      if (!orders.length) break;
      for (const order of orders) yield order;
      page += 1;
    }
  }
}

async function orderTransactions(orderId) {
  return bcGet(`/orders/${orderId}/transactions`);
}

async function orderShipments(orderId) {
  return bcGet(`/orders/${orderId}/shipments`);
}

async function appendSlaNote(orderId, existingNotes, message) {
  const note = (existingNotes || "").trimEnd();
  const updated = note ? `${note}\n${message}`.trim() : message;
  return bcPut(`/orders/${orderId}`, { staff_notes: updated });
}

export async function run() {
  const now = new Date();
  const orders = [];
  for await (const order of candidateOrders()) orders.push(order);

  const enriched = [];
  for (const order of orders) {
    const transactions = await orderTransactions(order.id);
    const shipments = await orderShipments(order.id);
    enriched.push({
      ...order,
      payment_status: hasCapturedPayment(transactions) ? "captured" : "uncaptured",
      has_shipment: shipments.length > 0,
    });
  }

  const overdue = findOverdueOrders(enriched, now, SLA_HOURS);

  for (const item of overdue) {
    const message =
      `[SLA-ALERT] Awaiting Shipment since ${item.dateCreated.toISOString()}, ` +
      `${item.ageHours.toFixed(1)}h over the ${SLA_HOURS}h promise ` +
      `- flagged ${now.toISOString()}`;
    console.warn(
      `order_id=${item.orderId} age_hours=${item.ageHours.toFixed(1)} ` +
      `overage_hours=${item.overageHours.toFixed(1)} ${DRY_RUN ? "would tag" : "tagging"}`
    );
    if (!DRY_RUN) {
      const order = orders.find((o) => o.id === item.orderId) || {};
      await appendSlaNote(item.orderId, order.staff_notes, message);
    }
  }

  console.log(`Done. ${overdue.length} order(s) ${DRY_RUN ? "to tag" : "tagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
