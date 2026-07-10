/**
 * Advance BigCommerce orders that were captured but never left Awaiting Payment.
 *
 * BigCommerce order status and payment status are decoupled from the real gateway
 * transaction. When a payment is authorize only, capturing it (by hand or with the
 * Capture Order Payment action) sets payment_status to Pending Capture while the
 * capture is processed out of band by the gateway. If the confirmation callback is
 * slow, silently fails, or the merchant captures directly in the gateway's own
 * dashboard, the order record never gets the follow up update and status_id stays
 * at 7 (Awaiting Payment) even though the transaction and the gateway both show the
 * money was captured. This job lists candidate orders at status_id 7, reads each
 * order's transactions, and advances only the ones with an unambiguous successful
 * capture or sale transaction whose amount matches the order total. Anything else
 * is flagged for manual review, never auto-advanced. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/orders-stuck-on-awaiting-payment-after-capture/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const AWAITING_PAYMENT = 7;
const AWAITING_FULFILLMENT = 11;

const CAPTURE_TYPES = new Set(["capture", "sale"]);
const AMOUNT_EPSILON = 0.01;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * if statusId !== 7: no_action.
 * Find capture/sale transactions with status "success" and amount matching
 * orderTotal within a currency-aware epsilon. If at least one matches,
 * advance_to_awaiting_fulfillment. If a capture transaction exists but is
 * pending, declined, or amount mismatched, flag_for_review. If there is no
 * capture-type transaction at all, no_action (genuinely unpaid).
 */
export function decideOrderRepair(statusId, transactions, orderTotal) {
  if (statusId !== AWAITING_PAYMENT) return "no_action";

  const total = Number.parseFloat(orderTotal);
  const hasTotal = Number.isFinite(total);

  let sawCaptureType = false;
  let hasMatchingSuccess = false;
  let hasProblemCapture = false;

  for (const txn of transactions || []) {
    const txnKind = (txn.type || txn.event || "").toLowerCase();
    if (!CAPTURE_TYPES.has(txnKind)) continue;
    sawCaptureType = true;

    const txnStatus = (txn.status || "").toLowerCase();
    const amount = Number.parseFloat(txn.amount);
    const amountMatches = hasTotal && Number.isFinite(amount) && Math.abs(amount - total) < AMOUNT_EPSILON;

    if (txnStatus === "success" && amountMatches) {
      hasMatchingSuccess = true;
    } else {
      hasProblemCapture = true;
    }
  }

  if (hasMatchingSuccess) return "advance_to_awaiting_fulfillment";
  if (sawCaptureType && hasProblemCapture) return "flag_for_review";
  return "no_action";
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
  let page = 1;
  while (true) {
    const orders = await bcGet("/orders", {
      status_id: AWAITING_PAYMENT,
      min_date_created: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderTransactions(orderId) {
  return bcGet(`/orders/${orderId}/transactions`);
}

async function advanceOrder(orderId) {
  return bcPut(`/orders/${orderId}`, { status_id: AWAITING_FULFILLMENT });
}

export async function run() {
  let advanced = 0;
  let flagged = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const orderTotal = order.total_inc_tax || order.total_ex_tax || "0";
    const transactions = await orderTransactions(orderId);

    const decision = decideOrderRepair(order.status_id, transactions, orderTotal);

    if (decision === "no_action") continue;

    if (decision === "flag_for_review") {
      console.warn(`Order ${orderId} flagged for review. total=${orderTotal} status_id=${order.status_id}`);
      flagged += 1;
      continue;
    }

    let gateway = null;
    let gatewayTransactionId = null;
    let transactionId = null;
    for (const txn of transactions || []) {
      const txnKind = (txn.type || txn.event || "").toLowerCase();
      if (CAPTURE_TYPES.has(txnKind) && (txn.status || "").toLowerCase() === "success") {
        gateway = txn.gateway;
        gatewayTransactionId = txn.gateway_transaction_id;
        transactionId = txn.id;
        break;
      }
    }

    console.log(
      `order_id=${orderId} order_total=${orderTotal} transaction_id=${transactionId} gateway=${gateway} ` +
      `gateway_transaction_id=${gatewayTransactionId} current_status_id=${order.status_id} ` +
      `target_status_id=${AWAITING_FULFILLMENT} (${DRY_RUN ? "dry run" : "advancing"})`
    );
    if (!DRY_RUN) await advanceOrder(orderId);
    advanced += 1;
  }

  console.log(
    `Done. ${advanced} order(s) ${DRY_RUN ? "to advance" : "advanced"}, ${flagged} order(s) flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
