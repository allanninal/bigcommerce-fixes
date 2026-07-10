/**
 * Restock BigCommerce Declined orders whose stock was never returned.
 *
 * BigCommerce debits inventory_level at order creation, and only returns it when
 * the order reaches a status your Inventory Settings map to "return stock",
 * typically Cancelled or Refunded. Declined (status_id 6) is often not covered,
 * so the debited stock sits withheld from real buyers. This lists recently
 * Declined orders, confirms with GET /v2/orders/{id}/transactions that nothing
 * was actually approved or captured, and returns each line item's quantity with
 * POST /v3/inventory/adjustments/relative. Orders with real money behind them
 * are flagged for a human instead of auto-restocked. Guarded by DRY_RUN. Safe
 * to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/declined-order-still-holds-stock/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const BASE_URL = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const LOOKBACK_DAYS = Number(process.env.RESTOCK_LOOKBACK_DAYS || 3);
const LOCATION_ID = Number(process.env.LOCATION_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DECLINED_STATUS_ID = 6;
const CHARGED_STATUSES = new Set(["approved", "captured"]);
const ADJUSTED_NOTE = "declined-order-restocked-by-script";

function headers() {
  return {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Pure decision function. No network calls.
 *
 * order: { status_id, products: [{ variant_id, sku, quantity }], already_adjusted }
 * transactions: [{ status }]
 *
 * Returns { action: "restock" | "flag" | "skip", items: [{ variant_id, qty }] }.
 *
 * Only Declined orders (status_id === 6) are candidates. An order already marked
 * adjusted is skipped so a second run never double-restocks it. If any
 * transaction shows an approved or captured status, money moved despite the
 * Declined status, so the order is flagged for a human instead of touched.
 * Otherwise every line item's quantity is queued to be added back.
 */
export function decideRestock(order, transactions) {
  if (order.status_id !== DECLINED_STATUS_ID) return { action: "skip", items: [] };
  if (order.already_adjusted) return { action: "skip", items: [] };
  if (transactions.some((t) => CHARGED_STATUSES.has(t.status))) return { action: "flag", items: [] };
  const items = order.products.map((p) => ({ variant_id: p.variant_id, qty: p.quantity }));
  return { action: "restock", items };
}

async function bcGet(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: headers() });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcPost(path, body) {
  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rfc1123(date) {
  return date.toUTCString().replace("GMT", "+0000");
}

async function* declinedOrders() {
  const since = rfc1123(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
  let page = 1;
  const limit = 50;
  while (true) {
    const orders = await bcGet("v2/orders", {
      status_id: DECLINED_STATUS_ID,
      min_date_modified: since,
      limit,
      page,
    });
    if (!orders || !orders.length) return;
    for (const order of orders) yield order;
    if (orders.length < limit) return;
    page += 1;
  }
}

async function getOrderProducts(orderId) {
  const products = (await bcGet(`v2/orders/${orderId}/products`)) || [];
  return products.map((p) => ({ variant_id: p.variant_id, sku: p.sku, quantity: p.quantity }));
}

async function getOrderTransactions(orderId) {
  return (await bcGet(`v2/orders/${orderId}/transactions`)) || [];
}

async function getOrderNotes(orderId) {
  return (await bcGet(`v2/orders/${orderId}/notes`)) || [];
}

async function isAlreadyAdjusted(orderId) {
  const notes = await getOrderNotes(orderId);
  return notes.some((n) => (n.note || "").includes(ADJUSTED_NOTE));
}

async function restockItems(items, locationId) {
  const payload = {
    reason: "Declined order restock reconciliation",
    location_id: locationId,
    items: items.map((i) => ({ variant_id: i.variant_id, quantity: i.qty })),
  };
  return bcPost("v3/inventory/adjustments/relative", payload);
}

async function markAdjusted(orderId) {
  return bcPost(`v2/orders/${orderId}/notes`, { note: ADJUSTED_NOTE });
}

export async function run() {
  let restocked = 0;
  let flagged = 0;
  for await (const order of declinedOrders()) {
    const orderId = order.id;
    const fullOrder = {
      status_id: order.status_id ?? DECLINED_STATUS_ID,
      products: await getOrderProducts(orderId),
      already_adjusted: await isAlreadyAdjusted(orderId),
    };
    const transactions = await getOrderTransactions(orderId);
    const decision = decideRestock(fullOrder, transactions);

    if (decision.action === "skip") continue;

    if (decision.action === "flag") {
      console.warn(`Order ${orderId} Declined but has approved/captured transactions. Flagged for manual review.`);
      flagged++;
      continue;
    }

    console.log(
      `Order ${orderId} eligible to restock ${decision.items.length} item(s). ${DRY_RUN ? "would restock" : "restocking"}`
    );
    if (!DRY_RUN) {
      await restockItems(decision.items, LOCATION_ID);
      await markAdjusted(orderId);
    }
    restocked++;
  }
  console.log(
    `Done. ${restocked} order(s) ${DRY_RUN ? "to restock" : "restocked"}, ${flagged} order(s) flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
