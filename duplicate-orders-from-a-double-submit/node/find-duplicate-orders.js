/**
 * Find and cancel duplicate BigCommerce orders created by a double submit.
 *
 * A slow payment gateway or an impatient double click on Place Order can turn one
 * checkout into two separate orders: same customer, same products, same total,
 * created seconds apart. This lists recent pre-fulfillment orders, groups them
 * with a pure function, keeps the earliest order in each group, and cancels the
 * rest, but only after re-checking that the duplicate has no captured payment.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/duplicate-orders-from-a-double-submit/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "storehash123";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const WINDOW_SECONDS = Number(process.env.DUPLICATE_WINDOW_SECONDS || 300);
const LOOKBACK_MINUTES = Number(process.env.LOOKBACK_MINUTES || 15);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = { "X-Auth-Token": TOKEN, "Accept": "application/json", "Content-Type": "application/json" };

const PRE_FULFILLMENT_STATUS_IDS = new Set([0, 1, 7, 9, 11]);
const CANCELLED_STATUS_ID = 5;

export function productSignature(products) {
  const parts = products.map((p) => `${p.product_id}x${p.quantity}`).sort();
  return parts.join("|");
}

function toMillis(dateCreated) {
  return new Date(dateCreated).getTime();
}

export function findDuplicateOrderGroups(orders, windowSeconds = 300) {
  const eligible = orders.filter((o) => PRE_FULFILLMENT_STATUS_IDS.has(o.status_id));

  const groups = new Map();
  for (const o of eligible) {
    const key = `${o.customer_id}|${o.product_signature}|${o.total_inc_tax}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const duplicateGroups = [];
  for (const members of groups.values()) {
    const sorted = [...members].sort((a, b) => toMillis(a.date_created) - toMillis(b.date_created));
    let cluster = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const deltaSeconds = (toMillis(sorted[i].date_created) - toMillis(sorted[i - 1].date_created)) / 1000;
      if (deltaSeconds <= windowSeconds) {
        cluster.push(sorted[i]);
      } else {
        if (cluster.length > 1) duplicateGroups.push(cluster.map((o) => o.id));
        cluster = [sorted[i]];
      }
    }
    if (cluster.length > 1) duplicateGroups.push(cluster.map((o) => o.id));
  }

  return duplicateGroups;
}

async function bcGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(BASE + path + (qs ? `?${qs}` : ""), { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcPut(path, body) {
  const res = await fetch(BASE + path, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function recentCandidateOrders(minDateCreated) {
  const orders = await bcGet("v2/orders", {
    min_date_created: minDateCreated,
    sort: "date_created:asc",
  });
  const out = [];
  for (const o of orders) {
    if (!PRE_FULFILLMENT_STATUS_IDS.has(o.status_id)) continue;
    const products = await bcGet(`v2/orders/${o.id}/products`);
    out.push({
      id: o.id,
      customer_id: o.customer_id,
      date_created: o.date_created,
      total_inc_tax: o.total_inc_tax,
      status_id: o.status_id,
      product_signature: productSignature(products),
    });
  }
  return out;
}

async function hasSettledTransaction(orderId) {
  const transactions = await bcGet(`v2/orders/${orderId}/transactions`);
  return transactions.some((t) => ["captured", "authorized"].includes(t.status));
}

async function cancelOrder(orderId) {
  return bcPut(`v2/orders/${orderId}`, { status_id: CANCELLED_STATUS_ID });
}

export async function run() {
  const minDateCreated = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000).toISOString();
  const orders = await recentCandidateOrders(minDateCreated);
  const groups = findDuplicateOrderGroups(orders, WINDOW_SECONDS);

  let cancelled = 0;
  let flagged = 0;
  for (const group of groups) {
    const [keeperId, ...duplicateIds] = group;
    for (const orderId of duplicateIds) {
      if (await hasSettledTransaction(orderId)) {
        console.warn(`Order ${orderId} has a captured transaction, flagging for manual refund then cancel.`);
        flagged++;
        continue;
      }
      console.log(`Order ${orderId} is a duplicate of ${keeperId}. ${DRY_RUN ? "would cancel" : "cancelling"}`);
      if (!DRY_RUN) await cancelOrder(orderId);
      cancelled++;
    }
  }

  console.log(`Done. ${cancelled} order(s) ${DRY_RUN ? "to cancel" : "cancelled"}, ${flagged} flagged for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
