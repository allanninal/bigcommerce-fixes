/**
 * Find BigCommerce orders marked Refunded or Partially Refunded with no real refund behind them.
 *
 * BigCommerce treats order status and money movement as two decoupled systems. The
 * status_id field is just a label on the order record, and PUT /v2/orders/{id} will
 * accept status_id 4 (Refunded) or 14 (Partially Refunded) with no side effect at all.
 * Real refunds only happen through the Payment Actions workflow, refund_quotes then
 * refunds, which calls the gateway and, only on success, writes a transaction and
 * updates status as a result. Staff using the Edit status dropdown instead of the
 * Refund action, or an integration that PUTs status_id 4 directly to mirror an
 * external refund, both leave the order showing Refunded with zero refund
 * transactions behind it. This job lists candidate orders at status_id 4 and 14,
 * reads each order's transactions, and reports every order where no refund-type
 * transaction exists and refunded_amount is still 0.00. There is no API to
 * retroactively attach a real refund to an order, so this never auto-repairs.
 * With DRY_RUN=false it additionally fetches a refund quote and prints the exact
 * refund request an operator would need to review and submit by hand. It never
 * calls the real refunds endpoint itself. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/manual-refunded-status-without-transaction/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const V2_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const V3_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REFUNDED = 4;
const PARTIALLY_REFUNDED = 14;
const REFUND_STATUS_IDS = new Set([REFUNDED, PARTIALLY_REFUNDED]);
const AMOUNT_EPSILON = 0.01;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * statusId from the BigCommerce order (4=Refunded, 14=Partially Refunded).
 * transactions is the list from GET /v2/orders/{id}/transactions, each an object
 * with a 'type' (or 'event') key. refundedAmount and totalIncTax are decimal
 * strings from the order resource. Returns true only when statusId is 4 or 14,
 * there is no refund-type transaction with a positive amount, and refundedAmount
 * is still effectively 0.00, meaning the status was changed with no money moved.
 */
export function isOrphanedRefundStatus(statusId, transactions, refundedAmount, totalIncTax) {
  if (!REFUND_STATUS_IDS.has(statusId)) return false;

  let hasRefundTxn = false;
  let refundTxnTotal = 0;
  for (const txn of transactions || []) {
    const kind = (txn.type || txn.event || "").toLowerCase();
    if (kind !== "refund") continue;
    const amount = Number.parseFloat(txn.amount);
    if (Number.isFinite(amount) && amount > 0) {
      hasRefundTxn = true;
      refundTxnTotal += amount;
    }
  }

  const recordedRefund = Number.parseFloat(refundedAmount);
  const noRecordedRefund = !Number.isFinite(recordedRefund) || recordedRefund < AMOUNT_EPSILON;

  return !hasRefundTxn && noRecordedRefund && refundTxnTotal < AMOUNT_EPSILON;
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

async function* candidateOrders(statusId) {
  let page = 1;
  while (true) {
    const orders = await bcGet(V2_BASE, "/orders", {
      status_id: statusId,
      min_date_modified: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderTransactions(orderId) {
  return bcGet(V2_BASE, `/orders/${orderId}/transactions`);
}

async function orderPaymentActionRefunds(orderId) {
  const result = await bcGet(V3_BASE, `/orders/${orderId}/payment_actions/refunds`);
  return (result && result.data) || [];
}

async function fetchRefundQuote(orderId) {
  return bcPost(V3_BASE, `/orders/${orderId}/payment_actions/refund_quotes`, {});
}

function buildReportRow(order, transactions) {
  return {
    order_id: order.id,
    status_id: order.status_id,
    total_inc_tax: order.total_inc_tax,
    refunded_amount: order.refunded_amount,
    transaction_count: (transactions || []).length,
  };
}

export async function run() {
  let orphaned = 0;

  for (const statusId of [REFUNDED, PARTIALLY_REFUNDED]) {
    for await (const order of candidateOrders(statusId)) {
      const orderId = order.id;
      const transactions = await orderTransactions(orderId);
      const paymentActionRefunds = await orderPaymentActionRefunds(orderId);

      const orphanedFlag = isOrphanedRefundStatus(
        order.status_id,
        transactions,
        order.refunded_amount,
        order.total_inc_tax,
      );
      if (!orphanedFlag) continue;

      if (paymentActionRefunds.length) {
        console.warn(
          `Order ${orderId} has payment_actions/refunds history but no matching transaction entry, needs manual review.`
        );
      }

      const row = buildReportRow(order, transactions);
      console.warn(
        `ORPHANED REFUND STATUS order_id=${row.order_id} status_id=${row.status_id} ` +
        `total_inc_tax=${row.total_inc_tax} refunded_amount=${row.refunded_amount} ` +
        `transaction_count=${row.transaction_count}`
      );
      orphaned += 1;

      if (!DRY_RUN) {
        const quote = await fetchRefundQuote(orderId);
        console.log(
          `Refund quote fetched for order_id=${orderId}. To submit, an operator must ` +
          `POST ${V3_BASE}/orders/${orderId}/payment_actions/refunds with body: ${JSON.stringify(quote)}`
        );
      }
    }
  }

  console.log(`Done. ${orphaned} order(s) flagged as orphaned Refunded status.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
