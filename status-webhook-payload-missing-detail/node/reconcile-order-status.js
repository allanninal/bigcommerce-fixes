/**
 * Find BigCommerce order status changes dropped by a thin webhook payload.
 *
 * The store/order/statusUpdated webhook's data object carries only
 * {"type":"order","id":<order_id>}, never the resulting status_id. Consumers
 * are required to make a follow-up GET /v2/orders/{id} to learn what actually
 * changed. If that follow-up GET fails, times out, hits a rate limit, or the
 * app crashes before it completes, the status change is dropped with nothing
 * left to retry from, because a webhook BigCommerce delivered successfully
 * (200 OK) is never resent even if your own internal follow-up call fails
 * afterward. This job keeps a local last-known status_id per order, lists
 * every order modified since the last successful pass, diffs their status_id
 * against local state, and re-fetches each mismatch from BigCommerce so a
 * human or a re-sync can repair the local shadow copy. It never writes a
 * status back to BigCommerce. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/status-webhook-payload-missing-detail/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_HOST = `https://api.bigcommerce.com/stores/${STORE_HASH}`;
const RECONCILE_LOOKBACK_HOURS = Number(process.env.RECONCILE_LOOKBACK_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STATUS_UPDATED_SCOPE = "store/order/statusUpdated";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * For each order in fetchedOrders (object with at least id, status_id,
 * date_modified), look up the locally stored last-known status_id. If there
 * is no local record, or it disagrees with the order's current status_id,
 * the order is a dropped update. Returns the list of all such mismatches,
 * empty if everything is in sync.
 */
export function diffOrderStatus(knownStatusByOrderId, fetchedOrders) {
  const mismatches = [];
  for (const order of fetchedOrders) {
    const orderId = order.id;
    const known = knownStatusByOrderId.has(orderId) ? knownStatusByOrderId.get(orderId) : null;
    if (known === null || known !== order.status_id) {
      mismatches.push({
        order_id: orderId,
        previous_known_status_id: known,
        current_status_id: order.status_id,
        date_modified: order.date_modified,
      });
    }
  }
  return mismatches;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_HOST}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function* ordersModifiedSince(lastCheckedIso8601) {
  let page = 1;
  while (true) {
    const orders = await bcGet("/v2/orders", {
      min_date_modified: lastCheckedIso8601,
      limit: 250,
      page,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function hookIsActive(scope = STATUS_UPDATED_SCOPE) {
  const hooks = await bcGet("/v3/hooks");
  for (const hook of hooks.data || []) {
    if (hook.scope === scope) return Boolean(hook.is_active);
  }
  return false;
}

async function refetchOrder(orderId) {
  return bcGet(`/v2/orders/${orderId}`);
}

export async function run({ knownStatusByOrderId = new Map(), lastCheckedIso8601 } = {}) {
  if (!lastCheckedIso8601) {
    const cutoff = new Date(Date.now() - RECONCILE_LOOKBACK_HOURS * 60 * 60 * 1000);
    lastCheckedIso8601 = cutoff.toISOString().slice(0, 19);
  }

  if (!(await hookIsActive())) {
    console.warn(
      "store/order/statusUpdated hook is not active. This explains a systemic gap, not just isolated follow-up GET failures."
    );
  }

  const fetchedOrders = [];
  for await (const order of ordersModifiedSince(lastCheckedIso8601)) fetchedOrders.push(order);

  const mismatches = diffOrderStatus(knownStatusByOrderId, fetchedOrders);

  let repaired = 0;
  let stillFailing = 0;
  for (const mismatch of mismatches) {
    const orderId = mismatch.order_id;
    let order;
    try {
      order = await refetchOrder(orderId);
    } catch (err) {
      console.error(`Re-fetch failed for order_id=${orderId} at ${mismatch.date_modified}: ${err.message}`);
      stillFailing += 1;
      continue;
    }

    console.log(
      `order_id=${orderId} previous_known_status_id=${mismatch.previous_known_status_id} ` +
      `current_status_id=${order.status_id} (${DRY_RUN ? "dry run" : "repairing local mirror"})`
    );
    if (!DRY_RUN) knownStatusByOrderId.set(orderId, order.status_id);
    repaired += 1;
  }

  console.log(
    `Done. ${mismatches.length} dropped update(s) found, ${repaired} ${DRY_RUN ? "to repair" : "repaired"}, ` +
    `${stillFailing} failed re-fetch and will retry next pass.`
  );
  return knownStatusByOrderId;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
