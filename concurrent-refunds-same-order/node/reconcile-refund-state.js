/**
 * Serialize BigCommerce refunds per order and flag orders already corrupted by a race.
 *
 * BigCommerce's refund workflow is two sequential calls per order,
 * POST /v3/orders/{id}/payment_actions/refund_quotes to compute the refundable
 * amount and eligible payment methods, then POST /v3/orders/{id}/payment_actions/refund
 * using that quote. Refund settlement against the gateway is asynchronous, so the
 * order's payment_status/status_id (Refunded=4, Partially Refunded=14) updates after
 * the API accepts the request, not atomically with it. BigCommerce's own docs state
 * that processing multiple concurrent refunds on the same order is not yet supported,
 * because there is no per-order idempotency lock at the API layer. When two refund
 * requests race for the same order_id, both can read the same pre-refund quote and
 * both get accepted, leaving the order mismatched.
 *
 * This script does two things. First, it wraps future refund calls in a per-order
 * lock (a promise chain keyed by order_id) so a second request for the same
 * order_id queues instead of racing. Second, it scans orders already at status_id
 * 4 or 14 and reconciles total_refunded against the actual sum of refund
 * transactions, flagging any duplicate or mismatch for a human. It never writes a
 * compensating refund or credit automatically, because BigCommerce has no
 * undo-refund endpoint and a second programmatic refund on an already-corrupted
 * order risks a real second charge reversal.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/concurrent-refunds-same-order/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REFUNDED = 4;
const PARTIALLY_REFUNDED = 14;
const RECONCILE_STATUS_IDS = [REFUNDED, PARTIALLY_REFUNDED];

const MISMATCH_EPSILON = 0.01;
const DUPLICATE_WINDOW_SECONDS = 1.0;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function parseTimestamp(dateCreated) {
  const ms = Date.parse(dateCreated);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * Group transactions by gateway_transaction_id, or by amount plus a close
 * date_created, and return the ids of any transaction that shares a group
 * with another transaction (a likely double submission).
 */
export function findDuplicateIds(refundTransactions) {
  const duplicateIds = new Set();

  const byGatewayId = new Map();
  for (const txn of refundTransactions) {
    const gwId = txn.gateway_transaction_id;
    if (!gwId) continue;
    if (!byGatewayId.has(gwId)) byGatewayId.set(gwId, []);
    byGatewayId.get(gwId).push(txn);
  }
  for (const group of byGatewayId.values()) {
    if (group.length > 1) group.forEach((t) => duplicateIds.add(t.id));
  }

  const remaining = refundTransactions.filter((t) => !duplicateIds.has(t.id));
  for (let i = 0; i < remaining.length; i += 1) {
    const a = remaining[i];
    const aTs = parseTimestamp(a.date_created);
    if (aTs === null) continue;
    for (let j = i + 1; j < remaining.length; j += 1) {
      const b = remaining[j];
      const bTs = parseTimestamp(b.date_created);
      if (bTs === null) continue;
      const sameAmount = a.amount === b.amount;
      const closeInTime = Math.abs(aTs - bTs) <= DUPLICATE_WINDOW_SECONDS;
      if (sameAmount && closeInTime) {
        duplicateIds.add(a.id);
        duplicateIds.add(b.id);
      }
    }
  }

  return [...duplicateIds].sort();
}

/**
 * Pure decision. No network, no side effects.
 *
 * Sums refundTransactions amounts, groups them by gateway_transaction_id or
 * by amount plus a close date_created to detect a duplicate submission, and
 * compares orderTotalRefunded against the sum to detect a mismatch.
 * Returns an object with "status" one of "ok", "flag_duplicate", or
 * "flag_mismatch", plus "discrepancy" and "duplicateIds".
 * orderTotalIncTax is accepted for context and future use but is not
 * required to make this decision.
 */
export function reconcileRefundState(orderTotalIncTax, orderTotalRefunded, refundTransactions) {
  const totalRefundAmount = refundTransactions.reduce((sum, t) => sum + t.amount, 0);
  const discrepancy = orderTotalRefunded - totalRefundAmount;

  const duplicateIds = findDuplicateIds(refundTransactions);
  if (duplicateIds.length > 0) {
    return { status: "flag_duplicate", discrepancy, duplicateIds };
  }

  if (Math.abs(discrepancy) > MISMATCH_EPSILON) {
    return { status: "flag_mismatch", discrepancy, duplicateIds: [] };
  }

  return { status: "ok", discrepancy, duplicateIds: [] };
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

async function bcPost(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const orderLocks = new Map();

/**
 * Acquire a per-order lock (a promise chain keyed by order_id), then call
 * refund_quotes and refund. The lock is released after the response, so a
 * second concurrent call for the same order_id waits instead of racing.
 */
export async function refundOrderSerialized(orderId, refundBody) {
  const prior = orderLocks.get(orderId) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  orderLocks.set(orderId, prior.then(() => next));
  await prior;
  try {
    if (DRY_RUN) {
      console.log(`DRY_RUN: would call refund_quotes and refund for order ${orderId}`);
      return { dryRun: true, orderId };
    }
    await bcPost(API_BASE_V3, `/orders/${orderId}/payment_actions/refund_quotes`, {});
    return await bcPost(API_BASE_V3, `/orders/${orderId}/payment_actions/refund`, refundBody);
  } finally {
    release();
  }
}

async function* ordersToReconcile() {
  for (const statusId of RECONCILE_STATUS_IDS) {
    let page = 1;
    while (true) {
      const orders = await bcGet(API_BASE_V2, "/orders", { status_id: statusId, page, limit: 50 });
      if (!orders.length) break;
      for (const order of orders) yield order;
      page += 1;
    }
  }
}

async function orderRefundTransactions(orderId) {
  const txns = await bcGet(API_BASE_V2, `/orders/${orderId}/transactions`);
  const parsed = [];
  for (const t of txns || []) {
    if ((t.type || "").toLowerCase() !== "refund") continue;
    const amount = Number.parseFloat(t.amount);
    if (!Number.isFinite(amount)) continue;
    parsed.push({
      id: String(t.id),
      amount,
      gateway_transaction_id: t.gateway_transaction_id || "",
      date_created: t.date_created || "",
    });
  }
  return parsed;
}

export async function run() {
  let checked = 0;
  let flagged = 0;

  for await (const order of ordersToReconcile()) {
    checked += 1;
    const orderId = order.id;
    const totalIncTax = Number.parseFloat(order.total_inc_tax || "0");
    const totalRefunded = Number.parseFloat(order.total_refunded ?? order.refunded_amount ?? "0");
    if (!Number.isFinite(totalIncTax) || !Number.isFinite(totalRefunded)) {
      console.warn(`order ${orderId} has an unparsable total, skipping`);
      continue;
    }

    const refundTransactions = await orderRefundTransactions(orderId);
    const result = reconcileRefundState(totalIncTax, totalRefunded, refundTransactions);

    if (result.status === "ok") continue;

    flagged += 1;
    console.warn(
      `order_id=${orderId} status=${result.status} discrepancy=${result.discrepancy} ` +
      `duplicate_ids=${JSON.stringify(result.duplicateIds)} total_refunded=${totalRefunded} total_inc_tax=${totalIncTax}`
    );
  }

  console.log(`Done. ${checked} order(s) checked, ${flagged} order(s) flagged for manual reconciliation.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
