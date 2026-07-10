/**
 * Flag BigCommerce orders that were disputed at the gateway but never marked Disputed.
 *
 * A chargeback happens between the customer's bank, the card network, and the
 * payment gateway. BigCommerce is not part of that conversation, so an order's
 * status_id only reaches 13 (Disputed) if a webhook happens to arrive and a
 * listener happens to catch it, or a person opens the order and sets it by
 * hand. Many gateways never send that event to BigCommerce at all, so a
 * genuinely disputed order can sit at its old status indefinitely while the
 * payout is already being reduced. This job lists recent orders, reads each
 * order's transactions, and flags only the ones with a clear dispute or
 * chargeback marker in a transaction's type or status, skipping any order
 * already in a settled status such as Disputed, Refunded, Cancelled, or
 * Partially Refunded. It never touches refunds, cancellations, or
 * fulfillment. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/disputed-order-not-flagged/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DISPUTED = 13;
const SETTLED_STATUSES = new Set([13, 4, 5, 14]); // Disputed, Refunded, Cancelled, Partially Refunded
const DISPUTE_MARKERS = ["chargeback", "dispute", "disputed"];

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * An order already sitting in a settled status (Disputed, Refunded,
 * Cancelled, Partially Refunded) is left alone, since that status already
 * reflects an outcome. Otherwise, scan the order's own transactions for a
 * type or status that clearly reads as a dispute or chargeback. Any match
 * means the order needs a flag.
 */
export function needsDisputeFlag(statusId, transactions) {
  if (SETTLED_STATUSES.has(statusId)) return false;

  for (const txn of transactions || []) {
    const txnKind = (txn.type || txn.event || "").toLowerCase();
    const txnStatus = (txn.status || "").toLowerCase();
    if (DISPUTE_MARKERS.some((marker) => txnKind.includes(marker) || txnStatus.includes(marker))) {
      return true;
    }
  }
  return false;
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

async function* recentOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGet("/orders", {
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

async function flagDisputed(orderId) {
  return bcPut(`/orders/${orderId}`, { status_id: DISPUTED });
}

export async function run() {
  let flagged = 0;

  for await (const order of recentOrders()) {
    const orderId = order.id;
    const statusId = order.status_id;
    const transactions = await orderTransactions(orderId);

    if (!needsDisputeFlag(statusId, transactions)) continue;

    let matchingTxn = null;
    for (const txn of transactions || []) {
      const txnKind = (txn.type || txn.event || "").toLowerCase();
      const txnStatus = (txn.status || "").toLowerCase();
      if (DISPUTE_MARKERS.some((marker) => txnKind.includes(marker) || txnStatus.includes(marker))) {
        matchingTxn = txn;
        break;
      }
    }

    console.warn(
      `order_id=${orderId} current_status_id=${statusId} transaction_id=${matchingTxn ? matchingTxn.id : null} ` +
      `transaction_type=${matchingTxn ? matchingTxn.type : null} ` +
      `${DRY_RUN ? "would flag as Disputed" : "flagging as Disputed"}`
    );
    if (!DRY_RUN) await flagDisputed(orderId);
    flagged += 1;
  }

  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
