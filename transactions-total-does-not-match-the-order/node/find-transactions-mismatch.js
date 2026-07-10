/**
 * Flag BigCommerce orders whose transactions do not add up to the order total.
 *
 * Order totals (total_inc_tax, refunded_amount) and the gateway transaction ledger
 * are written through separate code paths. A gateway-side refund, a partial or
 * store-credit refund never posted back as a transaction, or an overridden
 * refund_quote amount can leave the two records disagreeing. This reads each
 * recent order's total and refunded_amount, sums its settled purchase, capture,
 * and refund transactions, and writes a RECON_MISMATCH note to staff_notes when
 * the two disagree by more than a cent. It never edits total_inc_tax,
 * refunded_amount, or status_id. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/transactions-total-does-not-match-the-order/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const MIN_DATE_MODIFIED = process.env.MIN_DATE_MODIFIED || "";
const EPSILON_CENTS = Number(process.env.RECON_EPSILON_CENTS || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RECON_STATUS_IDS = new Set([2, 3, 4, 10, 14]);
const CHARGE_TYPES = new Set(["purchase", "capture"]);

export function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * Pure decision function. No network or DB calls.
 * order: { totalIncTax: number|string, refundedAmount: number|string }
 * transactions: Array<{ type: "purchase"|"capture"|"refund"|"void", amount: number|string, success: boolean }>
 *
 * Returns { isMismatched: boolean, expectedNet: number, actualNet: number, diffCents: number }
 * where the amounts are integer cents.
 */
export function reconcileOrderTransactions(order, transactions, epsilonCents = 1) {
  const settledIn = transactions
    .filter((t) => t.success && CHARGE_TYPES.has(t.type))
    .reduce((sum, t) => sum + toCents(t.amount), 0);
  const settledOut = transactions
    .filter((t) => t.success && t.type === "refund")
    .reduce((sum, t) => sum + toCents(t.amount), 0);
  const actualNet = settledIn - settledOut;
  const expectedNet = toCents(order.totalIncTax) - toCents(order.refundedAmount);
  const diffCents = actualNet - expectedNet;
  return {
    isMismatched: Math.abs(diffCents) > epsilonCents,
    expectedNet,
    actualNet,
    diffCents,
  };
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
      if (RECON_STATUS_IDS.has(Number(row.status_id))) yield row;
    }
    page++;
  }
}

async function orderTransactions(orderId) {
  const rows = (await bc("GET", `/v2/orders/${orderId}/transactions`)) || [];
  return rows.map((row) => ({ type: row.type, amount: row.amount, success: Boolean(row.success) }));
}

async function flagOrder(orderId, result) {
  const note = `RECON_MISMATCH: expected=${result.expectedNet} actual=${result.actualNet} diff=${result.diffCents}`;
  return bc("PUT", `/v2/orders/${orderId}`, { staff_notes: note });
}

export async function run() {
  let flagged = 0;
  for await (const row of ordersToCheck()) {
    const order = { totalIncTax: row.total_inc_tax, refundedAmount: row.refunded_amount };
    const transactions = await orderTransactions(row.id);
    const result = reconcileOrderTransactions(order, transactions, EPSILON_CENTS);
    if (!result.isMismatched) continue;
    console.warn(
      `Order #${row.id} mismatched. expected=${result.expectedNet} actual=${result.actualNet} diff=${result.diffCents}. ${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flagOrder(row.id, result);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
