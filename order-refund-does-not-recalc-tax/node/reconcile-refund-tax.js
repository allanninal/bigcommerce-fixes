/**
 * Find BigCommerce orders whose total_tax never moved after an order-level refund.
 *
 * BigCommerce refunds come in two flavors: line-item refunds, which reference a
 * specific product line and route through the store's tax provider to recompute
 * tax on the refunded quantity, and order-level or custom-amount refunds, sent
 * with item_type "ORDER". An order-level refund is treated as a flat, tax-exempt
 * custom amount against the total refundable order amount, so the Create Refund
 * Quote step returns total_refund_tax_amount = 0 and the refund is processed
 * without touching tax. The order's stored total_tax (and downstream
 * total_inc_tax/total_ex_tax) is never decremented for the tax portion of what
 * was actually refunded. Because BigCommerce exposes no supported endpoint to
 * directly patch total_tax after the fact, this job reports every mismatch as a
 * reconciliation record for a human or finance workflow, and only re-issues a
 * corrective line-item refund under an explicit non dry run flag.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-refund-does-not-recalc-tax/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MIN_DATE_MODIFIED = process.env.MIN_DATE_MODIFIED || "-30 days";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REFUNDED = 4;
const PARTIALLY_REFUNDED = 14;
const TOLERANCE = 0.01;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function toNum(value) {
  return Number.parseFloat(value || "0");
}

/**
 * Pure decision logic, no I/O, no side effects.
 *
 * order: {id, total_tax, total_ex_tax, total_inc_tax}
 * refundTransactions: [{id, type: "refund", item_type: "ORDER"|"PRODUCT", amount, tax_amount}]
 * Returns {order_id, expected_total_tax, stored_total_tax, delta, flagged, reason}
 *
 * Decision logic:
 *   1. originalTax = stored total_tax + sum(tax_amount for every refund transaction)
 *   2. expectedTotalTax = originalTax - sum(tax_amount for refund-type transactions only)
 *   3. orderLevelRefundWithoutTax = any refund transaction with item_type "ORDER", a
 *      positive amount, and a zero (or missing) tax_amount. That is the exact
 *      signature of an order-level refund that skipped tax recalculation.
 *   4. delta = abs(expectedTotalTax - storedTotalTax)
 *   5. flagged = delta > tolerance or orderLevelRefundWithoutTax
 *   6. reason = "order-level refund skipped tax recalculation" when that signature
 *      is present, otherwise "total_tax drift" when flagged, otherwise null.
 */
export function reconcileOrderTax(order, refundTransactions, tolerance = TOLERANCE) {
  const storedTotalTax = toNum(order.total_tax);

  const refundTaxSum = refundTransactions.reduce((s, t) => s + toNum(t.tax_amount), 0);
  const originalTax = storedTotalTax + refundTaxSum;

  const refundOnlyTaxSum = refundTransactions
    .filter((t) => t.type === "refund")
    .reduce((s, t) => s + toNum(t.tax_amount), 0);
  const expectedTotalTax = originalTax - refundOnlyTaxSum;

  const orderLevelRefundWithoutTax = refundTransactions.some(
    (t) => t.item_type === "ORDER" && toNum(t.amount) > 0 && toNum(t.tax_amount) === 0
  );

  const delta = Math.abs(expectedTotalTax - storedTotalTax);
  const flagged = delta > tolerance || orderLevelRefundWithoutTax;

  let reason = null;
  if (orderLevelRefundWithoutTax) reason = "order-level refund skipped tax recalculation";
  else if (flagged) reason = "total_tax drift";

  return {
    order_id: order.id,
    expected_total_tax: expectedTotalTax,
    stored_total_tax: storedTotalTax,
    delta,
    flagged,
    reason,
  };
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
  return res.json();
}

async function* candidateOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGet(API_BASE_V2, "/orders", {
      status_id: `${REFUNDED},${PARTIALLY_REFUNDED}`,
      min_date_modified: MIN_DATE_MODIFIED,
      page,
      limit: 250,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderRefundTransactions(orderId) {
  const transactions = await bcGet(API_BASE_V2, `/orders/${orderId}/transactions`);
  return transactions.filter((t) => (t.type || "").toLowerCase() === "refund");
}

async function quoteExpectedRefundTax(orderId, refundItemsOrAmount) {
  const body = { ...refundItemsOrAmount, dry_run: true };
  return bcPost(API_BASE_V3, `/orders/${orderId}/payment_actions/refund_quotes`, body);
}

async function issueCorrectiveRefund(orderId, shortfallAmount) {
  const body = { reason: "tax reconciliation shortfall", amount: String(shortfallAmount) };
  return bcPost(API_BASE_V3, `/orders/${orderId}/payment_actions/refunds`, body);
}

export async function run() {
  let ordersChecked = 0;
  let ordersFlagged = 0;

  for await (const order of candidateOrders()) {
    ordersChecked += 1;
    const orderId = order.id;
    const refundTransactions = await orderRefundTransactions(orderId);

    if (!refundTransactions.length) continue;

    const record = reconcileOrderTax(order, refundTransactions, TOLERANCE);

    if (!record.flagged) continue;

    ordersFlagged += 1;
    const refundTxnId = refundTransactions[0] ? refundTransactions[0].id : null;

    console.warn(
      `order_id=${record.order_id} stored_total_tax=${record.stored_total_tax} ` +
      `expected_total_tax=${record.expected_total_tax} delta=${record.delta} ` +
      `reason=${record.reason} refund_transaction_id=${refundTxnId}`
    );

    if (!DRY_RUN && order.refunded_amount !== undefined && order.refunded_amount !== null) {
      console.log(`order_id=${orderId} issuing corrective line-item refund for shortfall=${record.delta}`);
      await issueCorrectiveRefund(orderId, record.delta);
    }
  }

  console.log(
    `Done. ${ordersChecked} order(s) checked, ${ordersFlagged} order(s) flagged for tax reconciliation.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
