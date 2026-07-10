/**
 * Detect and repair BigCommerce orders where a gateway-side refund was never reflected.
 *
 * BigCommerce only updates an order's status_id and writes a refund transaction record
 * when a refund is initiated through its own admin Refund action, or the v3
 * payment_actions/refunds endpoint, which calls the gateway and updates the order
 * atomically. If a merchant or the payment processor issues the refund directly in the
 * gateway's own dashboard or API, there is no callback path into BigCommerce, so the
 * order silently stays at its prior status_id even though the customer has already been
 * refunded. This reads each order's total, its status_id, BigCommerce's own recorded
 * refund amount (from v2 transactions and v3 payment_actions/refunds), and the gateway's
 * refunded amount, then decides whether to set status_id to 4 (Refunded) or 14
 * (Partially Refunded), or to flag the order for manual review when the amounts do not
 * reconcile cleanly. Because BigCommerce has no endpoint to retroactively import a
 * gateway-executed refund as if it went through the Refund action, every write is paired
 * with an order note documenting the gateway refund id, amount, and timestamp so the
 * discrepancy stays traceable. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/gateway-refund-not-reflected-on-the-order/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const MIN_DATE_MODIFIED = process.env.MIN_DATE_MODIFIED || "";
const ROUNDING_TOLERANCE = Number(process.env.REFUND_ROUNDING_TOLERANCE || 0.01);
const REVIEW_TAG = process.env.REVIEW_TAG || "gateway-refund-needs-review";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STATUS_REFUNDED = 4;
const STATUS_PARTIALLY_REFUNDED = 14;
const ALREADY_REFUNDED_STATUSES = new Set([STATUS_REFUNDED, STATUS_PARTIALLY_REFUNDED]);
const CHECK_STATUS_IDS = new Set([2, 3, 9, 10, 11]);

/**
 * Pure decision function. No network calls.
 * orderTotal, gatewayRefundedAmount, bcRecordedRefundAmount: number (decimal currency units)
 * orderStatusId: number
 * Returns { action: "none"|"set_status"|"flag_manual_review", targetStatusId: number|null, reason: string }
 */
export function decideRefundStatus(orderTotal, orderStatusId, gatewayRefundedAmount, bcRecordedRefundAmount) {
  if (gatewayRefundedAmount < 0 || gatewayRefundedAmount - orderTotal > ROUNDING_TOLERANCE) {
    return {
      action: "flag_manual_review",
      targetStatusId: null,
      reason: `gatewayRefundedAmount ${gatewayRefundedAmount} is inconsistent with orderTotal ${orderTotal} (negative or exceeds total beyond tolerance)`,
    };
  }

  if (gatewayRefundedAmount <= bcRecordedRefundAmount) {
    return {
      action: "none",
      targetStatusId: null,
      reason: "gatewayRefundedAmount already reconciled with BigCommerce's recorded refund amount",
    };
  }

  const unrecorded = gatewayRefundedAmount - bcRecordedRefundAmount;
  let targetStatusId;
  let reason;

  if (gatewayRefundedAmount >= orderTotal - ROUNDING_TOLERANCE) {
    targetStatusId = STATUS_REFUNDED;
    reason = `gatewayRefundedAmount ${gatewayRefundedAmount} covers the order total ${orderTotal}`;
  } else if (unrecorded > 0) {
    targetStatusId = STATUS_PARTIALLY_REFUNDED;
    reason = `unrecorded refund amount ${unrecorded} found on the gateway that BigCommerce has not recorded`;
  } else {
    return { action: "none", targetStatusId: null, reason: "no unrecorded refund amount" };
  }

  if (orderStatusId === targetStatusId) {
    return {
      action: "none",
      targetStatusId: null,
      reason: `orderStatusId already equals target status_id ${targetStatusId}`,
    };
  }

  return { action: "set_status", targetStatusId, reason };
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

async function* ordersToCheck() {
  let page = 1;
  while (true) {
    let params = `page=${page}&limit=50`;
    if (MIN_DATE_MODIFIED) params += `&min_date_modified=${MIN_DATE_MODIFIED}`;
    const rows = await bc("GET", `/v2/orders?${params}`);
    if (!rows || rows.length === 0) return;
    for (const row of rows) {
      const statusId = Number(row.status_id);
      if (!ALREADY_REFUNDED_STATUSES.has(statusId) && CHECK_STATUS_IDS.has(statusId)) yield row;
    }
    page++;
  }
}

async function bcRecordedRefundAmountV2(orderId) {
  const rows = (await bc("GET", `/v2/orders/${orderId}/transactions`)) || [];
  return rows
    .filter((row) => row.type === "refund" && row.success)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

async function bcRecordedRefundAmountV3(orderId) {
  const body = (await bc("GET", `/v3/orders/${orderId}/payment_actions/refunds`)) || {};
  let total = 0;
  for (const row of body.data || []) {
    for (const detail of row.details || []) total += Number(detail.amount || 0);
  }
  return total;
}

async function gatewayRefundedAmount(_orderId) {
  // In production this calls the gateway's own API (Stripe, Braintree, Authorize.net,
  // etc.) with the transaction id recorded on the order. This stub is a seam for that
  // call; wire in your gateway client here.
  throw new Error("NOT_WIRED_IN");
}

async function flagForManualReview(orderId, reason) {
  const note = `GATEWAY_REFUND_REVIEW: ${reason}`;
  return bc("PUT", `/v2/orders/${orderId}`, { staff_notes: note });
}

async function applyStatus(orderId, targetStatusId, gatewayRefundId, amount, timestamp) {
  const note = `GATEWAY_REFUND_SYNCED: gateway_refund_id=${gatewayRefundId} amount=${amount} at=${timestamp} synced_status_id=${targetStatusId}`;
  await bc("PUT", `/v2/orders/${orderId}`, { staff_notes: note });
  return bc("PUT", `/v2/orders/${orderId}`, { status_id: targetStatusId });
}

export async function run() {
  let changed = 0;
  let flagged = 0;
  for await (const row of ordersToCheck()) {
    const orderId = row.id;
    const orderTotal = Number(row.total_inc_tax || 0);
    const orderStatusId = Number(row.status_id);

    const bcRecorded = (await bcRecordedRefundAmountV2(orderId)) + (await bcRecordedRefundAmountV3(orderId));

    let gwRefunded;
    try {
      gwRefunded = await gatewayRefundedAmount(orderId);
    } catch (err) {
      if (err.message === "NOT_WIRED_IN") {
        continue;
      }
      throw err;
    }

    const decision = decideRefundStatus(orderTotal, orderStatusId, gwRefunded, bcRecorded);

    if (decision.action === "none") continue;

    if (decision.action === "flag_manual_review") {
      console.warn(`Order #${orderId} flagged for manual review: ${decision.reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
      if (!DRY_RUN) await flagForManualReview(orderId, decision.reason);
      flagged++;
      continue;
    }

    console.log(`Order #${orderId}: ${decision.reason}. ${DRY_RUN ? `would set status_id=${decision.targetStatusId}` : `setting status_id=${decision.targetStatusId}`}`);
    if (!DRY_RUN) await applyStatus(orderId, decision.targetStatusId, "unknown", gwRefunded, "unknown");
    changed++;
  }
  console.log(`Done. ${changed} order(s) ${DRY_RUN ? "to set" : "set"} status, ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"} for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
