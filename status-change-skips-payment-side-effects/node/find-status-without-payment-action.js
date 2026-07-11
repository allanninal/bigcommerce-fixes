/**
 * Find BigCommerce orders whose status_id implies a completed payment action,
 * a refund, a void, or a capture, that never actually happened at the
 * gateway.
 *
 * BigCommerce's admin Action menu (Refund, Void transaction, Capture funds)
 * is what calls the payment gateway; it updates status_id only as a side
 * effect after that call succeeds. status_id itself is a plain label with no
 * hook back into the gateway. Writing it directly with PUT /v2/orders/{id}
 * changes the label instantly but skips the gateway call entirely, so an
 * order can read Refunded or Cancelled with no refund or void transaction
 * ever created. This job lists candidate orders by status_id, reads each
 * order's transactions, and flags any order whose implied payment action has
 * no matching successful transaction to back it up. It never writes
 * status_id and never calls a payment action on its own; it only reports,
 * for a human to confirm before any remediation.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/status-change-skips-payment-side-effects/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const CANDIDATE_STATUS_IDS = (process.env.CANDIDATE_STATUS_IDS || "4,5,10,14")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

const REFUND_STATUS_IDS = new Set([4, 14]);                 // Refunded, Partially Refunded
const CANCELLED_STATUS_ID = 5;                               // Cancelled
const CAPTURE_IMPLIED_STATUS_IDS = new Set([2, 9, 10, 11]);  // Shipped, Awaiting Shipment, Completed, Awaiting Fulfillment

/**
 * Pure decision. No network, no side effects.
 *
 * order: object with at least {id, status_id, payment_status}
 * transactions: array of objects with at least {type, status}
 *
 * Only transactions with status "ok" count as real side effects. An order
 * is treated as authorize-only if it has an ok "auth" transaction with no
 * matching ok "capture" or "purchase". Returns a violation code
 * (MISSING_REFUND, MISSING_VOID, MISSING_CAPTURE) or null if the status and
 * the transaction history are consistent.
 */
export function findStatusWithoutPaymentAction(order, transactions) {
  const okTxns = (transactions || []).filter((t) => t.status === "ok");
  const has = (ttype) => okTxns.some((t) => t.type === ttype);
  const hadAuthOnly = has("auth") && !has("capture") && !has("purchase");

  const statusId = order.status_id;
  if (REFUND_STATUS_IDS.has(statusId) && !has("refund")) return "MISSING_REFUND";
  if (statusId === CANCELLED_STATUS_ID && hadAuthOnly && !has("void")) return "MISSING_VOID";
  if (CAPTURE_IMPLIED_STATUS_IDS.has(statusId) && hadAuthOnly) return "MISSING_CAPTURE";
  return null;
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

async function* candidateOrders() {
  let page = 1;
  while (true) {
    let foundAny = false;
    for (const statusId of CANDIDATE_STATUS_IDS) {
      const orders = await bcGet("/orders", { status_id: statusId, page, limit: 250 });
      for (const order of orders) {
        foundAny = true;
        yield order;
      }
    }
    if (!foundAny) return;
    page += 1;
  }
}

async function orderTransactions(orderId) {
  return bcGet(`/orders/${orderId}/transactions`);
}

function buildReport(order, transactions, violation) {
  const lastTransaction = transactions.length ? transactions[transactions.length - 1] : null;
  return {
    orderId: order.id,
    statusId: order.status_id,
    paymentStatus: order.payment_status,
    missingAction: violation,
    lastTransaction,
  };
}

/**
 * Gated remediation. Never called from run(); only wire this up after a
 * human has confirmed a specific orderId list from the report below.
 *
 * action is one of "capture", "void", "refund". Each maps to
 * POST https://api.bigcommerce.com/stores/{store_hash}/v3/orders/{order_id}/payment_actions/{action}
 * (refund additionally requires a prior refund_quotes call). Always keep
 * this behind DRY_RUN so a real gateway call only fires when a human has
 * approved the order.
 */
async function applyRemediation(orderId, action) {
  if (DRY_RUN) {
    console.log(`DRY_RUN: would call payment_actions/${action} for order ${orderId}`);
    return null;
  }
  throw new Error("Wire this to the v3 payment_actions endpoint only after manual, per-order approval");
}

export async function run() {
  let flagged = 0;
  let clean = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const transactions = await orderTransactions(orderId);

    const violation = findStatusWithoutPaymentAction(order, transactions);
    if (violation === null) {
      clean += 1;
      continue;
    }

    flagged += 1;
    const report = buildReport(order, transactions, violation);
    console.warn(
      `order_id=${report.orderId} status_id=${report.statusId} payment_status=${report.paymentStatus} ` +
      `missing_action=${report.missingAction} last_transaction=${JSON.stringify(report.lastTransaction)}`
    );
  }

  console.log(`Done. ${flagged} order(s) flagged, ${clean} order(s) consistent.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
