/**
 * Reconcile BigCommerce order events missed during a deactivated webhook.
 *
 * BigCommerce webhook delivery is at-least-once, but it is not durable forever.
 * If your endpoint returns non-2xx or times out, BigCommerce retries on a
 * backoff schedule for roughly 48 hours across up to 11 attempts, then gives up,
 * sets the hook's is_active to false, and emails the app's registered contact.
 * There is no dead letter queue, event log, or replay API. This scans orders
 * modified during the outage window, diffs each one against locally stored
 * state, and replays anything missing or stale through the app's own idempotent
 * order sync handler using freshly fetched order data. It never calls a
 * destructive BigCommerce write. The only write is reactivating the hook once
 * the backfill is confirmed.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/missed-webhooks-with-no-backfill/
 *
 * Run once after a confirmed outage. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const WINDOW_START = process.env.WINDOW_START || "1970-01-01T00:00:00+00:00";
const WINDOW_END = process.env.WINDOW_END || "1970-01-02T00:00:00+00:00";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No network calls.
 *
 * localState: { statusId: number, dateModified: string } | null
 *   The last state your app has stored for this order, or null if it has
 *   never been seen.
 * remoteOrder: { statusId: number, dateModified: string }
 *   The order's current state as reported by BigCommerce.
 * windowStart, windowEnd: ISO 8601 strings
 *   The confirmed outage window.
 *
 * Returns true if the order should go into the replay queue: either it was
 * never recorded locally, its statusId has since moved on, or the local
 * record is older than what BigCommerce now reports, provided the remote
 * order's own dateModified falls within [windowStart, windowEnd].
 */
export function isOrderMissed(localState, remoteOrder, windowStart, windowEnd) {
  const remoteModified = remoteOrder.dateModified;
  if (!(windowStart <= remoteModified && remoteModified <= windowEnd)) return false;
  if (localState === null || localState === undefined) return true;
  if (localState.statusId !== remoteOrder.statusId) return true;
  return localState.dateModified < remoteModified;
}

async function bc(method, path, body) {
  const res = await fetch(BASE + path.replace(/^\//, ""), {
    method,
    headers: { "X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function hooksNeedingBackfill() {
  const hooks = (await bc("GET", "/v3/hooks")).data;
  return hooks.filter((h) => h.is_active === false);
}

async function* ordersInWindow() {
  let page = 1;
  while (true) {
    const rows = await bc(
      "GET",
      `/v2/orders?min_date_modified=${WINDOW_START}&max_date_modified=${WINDOW_END}` +
        `&limit=250&page=${page}`
    );
    if (!rows || rows.length === 0) return;
    for (const row of rows) yield row;
    page++;
  }
}

function loadLocalState(_orderId) {
  // Look up your own app's last recorded state for this order. Replace with
  // your own storage layer. Must return { statusId, dateModified } or null.
  return null;
}

async function replayOrder(orderId, syncHandler) {
  // This is a reconciliation replay, not a call to any BigCommerce write
  // endpoint. It only reads from BigCommerce and invokes the same idempotent
  // handler a real webhook would have triggered.
  const order = await bc("GET", `/v2/orders/${orderId}`);
  const products = (await bc("GET", `/v2/orders/${orderId}/products`)) || [];
  const shipments = (await bc("GET", `/v2/orders/${orderId}/shipments`)) || [];
  const transactions = (await bc("GET", `/v2/orders/${orderId}/transactions`)) || [];
  await syncHandler(order, products, shipments, transactions);
}

async function reactivateHook(hookId) {
  // The one safe, additive BigCommerce write involved: turn the hook back on.
  return bc("PUT", `/v3/hooks/${hookId}`, { is_active: true });
}

async function defaultSyncHandler(order) {
  console.log(`Would sync order #${order.id} status_id=${order.status_id}`);
}

export async function run(syncHandler = defaultSyncHandler) {
  let replayed = 0;
  for await (const row of ordersInWindow()) {
    const localState = loadLocalState(row.id);
    const remoteOrder = { statusId: Number(row.status_id), dateModified: row.date_modified };
    if (!isOrderMissed(localState, remoteOrder, WINDOW_START, WINDOW_END)) continue;
    console.warn(
      `Order #${row.id} missed. status_id=${row.status_id}. ${DRY_RUN ? "would replay" : "replaying"}`
    );
    if (!DRY_RUN) await replayOrder(row.id, syncHandler);
    replayed++;
  }

  if (!DRY_RUN) {
    for (const hook of await hooksNeedingBackfill()) {
      console.log(`Reactivating hook ${hook.id}`);
      await reactivateHook(hook.id);
    }
  }

  console.log(`Done. ${replayed} order(s) ${DRY_RUN ? "to replay" : "replayed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
