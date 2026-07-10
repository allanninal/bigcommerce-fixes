/**
 * Flag BigCommerce orders whose persisted tax does not match its own line detail.
 *
 * BigCommerce's tax engine rounds sales tax per line item, unit price times rate,
 * rounding a half cent or above up to the nearest cent, then sums those independently
 * rounded line amounts into order.total_tax. The storefront cart or checkout can show
 * a subtotal-level estimate or an async tax provider figure, so what the customer saw
 * and what BigCommerce persisted can differ by a cent or more. This reads each order's
 * total_tax alongside the authoritative /taxes breakdown and the /products line detail,
 * sums both independently, and writes a TAX_MISMATCH note to staff_notes when they
 * disagree by a cent or more. It never edits total_tax or price_tax. Run on a schedule.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-tax-off-by-a-cent/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const TOLERANCE_CENTS = Number(process.env.TAX_EPSILON_CENTS || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RECON_STATUS_IDS = new Set([0, 1, 7, 9, 11]);

export function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * Pure decision function. No network calls.
 * order: { id: number, total_tax: string, status_id: number }
 * orderTaxes: Array<{ name: string, amount: string, rate: string }>
 * orderProducts: Array<{ price_tax: string, quantity: number, price_ex_tax: string }>
 *
 * Returns null when both the /taxes sum and the /products price_tax sum are
 * within toleranceCents of order.total_tax. Otherwise returns a mismatch
 * record naming whichever source disagrees by the larger magnitude.
 */
export function findTaxMismatch(order, orderTaxes, orderProducts, toleranceCents = 1) {
  const sumTaxesEndpoint = orderTaxes.reduce((sum, t) => sum + toCents(t.amount), 0);
  const sumProductsTax = orderProducts.reduce((sum, p) => sum + toCents(p.price_tax), 0);
  const actualTax = toCents(order.total_tax);

  const deltaA = actualTax - sumTaxesEndpoint;
  const deltaB = actualTax - sumProductsTax;

  if (Math.abs(deltaA) <= toleranceCents && Math.abs(deltaB) <= toleranceCents) {
    return null;
  }

  const useA = Math.abs(deltaA) >= Math.abs(deltaB);
  const source = useA ? "taxes_endpoint" : "products_sum";
  const deltaCents = useA ? deltaA : deltaB;
  const expectedCents = useA ? sumTaxesEndpoint : sumProductsTax;

  return {
    orderId: order.id,
    mismatch: true,
    deltaCents,
    expectedTax: expectedCents / 100,
    actualTax: actualTax / 100,
    source,
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
    const rows = await bc("GET", `/v2/orders?page=${page}&limit=50`);
    if (!rows || rows.length === 0) return;
    for (const row of rows) {
      if (RECON_STATUS_IDS.has(Number(row.status_id))) yield row;
    }
    page++;
  }
}

async function orderTaxes(orderId) {
  const rows = (await bc("GET", `/v2/orders/${orderId}/taxes`)) || [];
  return rows.map((row) => ({ name: row.name, amount: row.amount, rate: row.rate }));
}

async function orderProducts(orderId) {
  const rows = (await bc("GET", `/v2/orders/${orderId}/products`)) || [];
  return rows.map((row) => ({ price_tax: row.price_tax, quantity: row.quantity, price_ex_tax: row.price_ex_tax }));
}

async function flagOrder(orderId, result) {
  const note = `TAX_MISMATCH: total_tax=${result.actualTax} taxes_sum=${result.expectedTax} delta=${result.deltaCents} cents - needs manual credit/adjustment`;
  return bc("PUT", `/v2/orders/${orderId}`, { staff_notes: note });
}

export async function run() {
  let flagged = 0;
  for await (const row of ordersToCheck()) {
    const order = { id: row.id, total_tax: row.total_tax, status_id: row.status_id };
    const taxes = await orderTaxes(row.id);
    const products = await orderProducts(row.id);
    const result = findTaxMismatch(order, taxes, products, TOLERANCE_CENTS);
    if (result === null) continue;
    console.warn(
      `Order #${row.id} tax mismatched via ${result.source}. total_tax=${result.actualTax} expected=${result.expectedTax} delta=${result.deltaCents} cents. ${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flagOrder(row.id, result);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
