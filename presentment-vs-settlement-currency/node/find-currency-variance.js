/**
 * Flag BigCommerce orders where presentment and settlement currency diverge.
 *
 * When Multi-Currency is enabled, a shopper can pay in a transactional currency
 * (default_currency_code) that differs from the store's base currency
 * (store_default_currency_code). BigCommerce records the rate between the two as
 * store_default_to_transactional_exchange_rate, but a finance export that reads
 * only the face-value total, or a gateway that settles to the bank in a third
 * currency at its own rate, can leave the presentment amount, the order total,
 * and the settlement amount all disagreeing. This reads each financially final
 * order's currency fields, computes the expected base-currency amount, compares
 * it against your ledger's recorded amount for that order, and writes an
 * FX_VARIANCE note to staff_notes when they disagree by more than a tolerance.
 * It never edits total_inc_tax, default_currency_code, or the exchange rate.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/presentment-vs-settlement-currency/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const MIN_DATE_CREATED = process.env.MIN_DATE_CREATED || "";
const TOLERANCE_RATIO = Number(process.env.FX_TOLERANCE_RATIO || 0.005);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Financially final BigCommerce order statuses: Completed, Awaiting
// Fulfillment, Shipped, Partially Shipped, Partially Refunded.
const FINAL_STATUS_IDS = new Set([10, 11, 2, 3, 14]);

/**
 * Pure decision function. No network calls.
 * order: {
 *   defaultCurrencyCode: string, storeDefaultCurrencyCode: string,
 *   totalIncTax: number|string, storeDefaultToTransactionalExchangeRate: number|string,
 *   ledgerBaseAmount: number|string,
 * }
 *
 * Returns whether the order's presentment currency differs from the store's
 * base currency AND the expected base-currency amount (totalIncTax times the
 * storeDefaultToTransactionalExchangeRate) diverges from the ledger's
 * recorded base amount by more than toleranceRatio.
 */
export function classifyCurrencyVariance(order, toleranceRatio = 0.005) {
  const { defaultCurrencyCode, storeDefaultCurrencyCode, totalIncTax,
          storeDefaultToTransactionalExchangeRate, ledgerBaseAmount } = order;

  const isMismatch = defaultCurrencyCode !== storeDefaultCurrencyCode;
  const total = Number(totalIncTax);
  const rate = Number(storeDefaultToTransactionalExchangeRate);
  const expectedBaseAmount = isMismatch ? total * rate : total;
  const variance = Math.abs(expectedBaseAmount - Number(ledgerBaseAmount));
  const varianceRatio = expectedBaseAmount ? variance / expectedBaseAmount : 0;

  return {
    isMismatch: isMismatch && varianceRatio > toleranceRatio,
    presentmentCurrency: defaultCurrencyCode,
    settlementCurrency: storeDefaultCurrencyCode,
    expectedBaseAmount,
    variance,
    varianceRatio,
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
    if (MIN_DATE_CREATED) params += `&min_date_created=${MIN_DATE_CREATED}`;
    const rows = await bc("GET", `/v2/orders?${params}`);
    if (!rows || rows.length === 0) return;
    for (const row of rows) {
      if (FINAL_STATUS_IDS.has(Number(row.status_id))) yield row;
    }
    page++;
  }
}

async function orderTransactions(orderId) {
  return (await bc("GET", `/v2/orders/${orderId}/transactions`)) || [];
}

/**
 * Placeholder for your own ledger lookup. Wire this to your accounting
 * export or payout report keyed by order_id. Falls back to summing settled
 * gateway transaction amounts when no external ledger is configured.
 */
function ledgerBaseAmountFor(orderId, transactions) {
  return transactions
    .filter((t) => t.success)
    .reduce((sum, t) => sum + Number(t.amount), 0);
}

async function flagOrder(orderId, result) {
  const note = `FX_VARIANCE: presentment=${result.presentmentCurrency} ` +
    `settlement=${result.settlementCurrency} ` +
    `expected=${result.expectedBaseAmount.toFixed(2)} ` +
    `variance=${result.variance.toFixed(2)} ` +
    `ratio=${result.varianceRatio.toFixed(4)}`;
  return bc("PUT", `/v2/orders/${orderId}`, { staff_notes: note });
}

export async function run() {
  let flagged = 0;
  for await (const row of ordersToCheck()) {
    const transactions = await orderTransactions(row.id);
    const order = {
      defaultCurrencyCode: row.default_currency_code || row.currency_code,
      storeDefaultCurrencyCode: row.store_default_currency_code || row.currency_code,
      totalIncTax: row.total_inc_tax,
      storeDefaultToTransactionalExchangeRate: row.store_default_to_transactional_exchange_rate || 1,
      ledgerBaseAmount: ledgerBaseAmountFor(row.id, transactions),
    };
    const result = classifyCurrencyVariance(order, TOLERANCE_RATIO);
    if (!result.isMismatch) continue;
    console.warn(
      `Order #${row.id} currency variance. presentment=${result.presentmentCurrency} settlement=${result.settlementCurrency} expected=${result.expectedBaseAmount.toFixed(2)} variance=${result.variance.toFixed(2)} ratio=${result.varianceRatio.toFixed(4)}. ${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flagOrder(row.id, result);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
