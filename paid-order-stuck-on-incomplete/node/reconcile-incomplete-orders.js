/**
 * Find BigCommerce orders stuck on Incomplete (status_id 0) that were actually paid.
 *
 * BigCommerce writes an order the moment a shopper reaches the payment page, before
 * the gateway result is known. A second call from the gateway is supposed to flip the
 * order to Awaiting Fulfillment (status_id 11). When that callback is delayed, dropped,
 * or the gateway never notifies BigCommerce, the order is stuck on Incomplete even
 * though a real transaction and a capture exist on the gateway side. Incomplete orders
 * are excluded from the normal fulfillment queue, so these sit invisible until a
 * customer complains.
 *
 * This job lists Incomplete orders in a lookback window, pulls each order's
 * transactions, and classifies it with a pure function. Confirmed paid-but-incomplete
 * orders are moved to Awaiting Fulfillment (status_id 11). Orders with conflicting
 * signals (a capture followed by a void, or a decline) are only logged for manual
 * review, never auto-repaired. Guarded by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/paid-order-stuck-on-incomplete/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "store_dummy";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "token_dummy";
const BASE_URL = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const INCOMPLETE_STATUS_ID = 0;
const AWAITING_FULFILLMENT_STATUS_ID = 11;

const CHARGE_TYPES = new Set(["purchase", "capture"]);
const SUCCESS_STATUSES = new Set(["success", "approved"]);
const CONFLICT_STATUSES = new Set(["declined", "failed"]);

/**
 * Pure decision function. No network calls.
 *
 * Only Incomplete orders (status_id === 0) are candidates. Among their purchase or
 * capture transactions: if a successful one coexists with a void or a declined or
 * failed one, the signals conflict and the order needs a human. If at least one
 * successful purchase or capture exists with no conflict, the order can advance to
 * Awaiting Fulfillment. Otherwise (no charge transactions, or only pending or
 * declined ones) there is nothing to do.
 */
export function decideOrderRepair(statusId, transactions) {
  if (statusId !== INCOMPLETE_STATUS_ID) return "no_action";

  const charges = transactions.filter((t) => CHARGE_TYPES.has(t.type));
  if (charges.length === 0) return "no_action";

  const isSuccessful = (t) => SUCCESS_STATUSES.has(t.status) && Boolean(t.gateway_transaction_id);

  const hasSuccess = charges.some(isSuccessful);
  const hasConflict = transactions.some(
    (t) => t.type === "void" || CONFLICT_STATUSES.has(t.status)
  );

  if (hasSuccess && hasConflict) return "flag_for_review";
  if (hasSuccess) return "advance_to_awaiting_fulfillment";
  return "no_action";
}

function headers() {
  return {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function minDateCreated() {
  const d = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return d.toUTCString().replace("GMT", "+0000");
}

async function* listIncompleteOrders() {
  const limit = 50;
  let page = 1;
  const since = minDateCreated();
  while (true) {
    const url = new URL(BASE_URL + "v2/orders");
    url.searchParams.set("status_id", String(INCOMPLETE_STATUS_ID));
    url.searchParams.set("min_date_created", since);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));

    const res = await fetch(url, { headers: headers() });
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
    const orders = await res.json();
    if (!orders || orders.length === 0) return;
    for (const order of orders) yield order;
    if (orders.length < limit) return;
    page++;
  }
}

async function getTransactions(orderId) {
  const res = await fetch(BASE_URL + `v2/orders/${orderId}/transactions`, { headers: headers() });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function advanceToAwaitingFulfillment(orderId) {
  const res = await fetch(BASE_URL + `v2/orders/${orderId}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ status_id: AWAITING_FULFILLMENT_STATUS_ID }),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

export async function run() {
  let advanced = 0;
  let flagged = 0;

  for await (const order of listIncompleteOrders()) {
    const orderId = order.id;
    const transactions = await getTransactions(orderId);
    const decision = decideOrderRepair(order.status_id ?? INCOMPLETE_STATUS_ID, transactions);

    if (decision === "no_action") continue;

    if (decision === "flag_for_review") {
      console.warn(`Order ${orderId} has conflicting transaction signals. Flagged for manual review.`);
      flagged++;
      continue;
    }

    console.log(
      `Order ${orderId} is paid but Incomplete. ${DRY_RUN ? "would advance to Awaiting Fulfillment" : "advancing to Awaiting Fulfillment"}`
    );
    if (!DRY_RUN) await advanceToAwaitingFulfillment(orderId);
    advanced++;
  }

  console.log(
    `Done. ${advanced} order(s) ${DRY_RUN ? "to advance" : "advanced"}, ${flagged} order(s) flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
