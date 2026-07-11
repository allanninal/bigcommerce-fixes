/**
 * Restock BigCommerce inventory for refunded line items that are safe to restock.
 *
 * BigCommerce's refund flow, POST /v3/orders/{order_id}/payment_actions/refunds
 * and the legacy /v2/orders/{id}/transactions path, is scoped purely to
 * reversing the payment with the gateway. It records which line items and
 * quantities were refunded but never touches the catalog or inventory
 * subsystem. Stock levels (inventory_level, inventory_warning_level) live on
 * /v3/catalog/products and its variants and only change from order creation
 * or cancellation triggers, direct catalog PUTs, or the dedicated
 * /v3/inventory/adjustments endpoints. Because refunds are commonly partial,
 * issued out of band, and do not always mean the item is restockable
 * (damaged, lost in transit, goodwill refund), BigCommerce leaves the restock
 * decision to the merchant, so refunded quantity and on-hand stock silently
 * drift apart unless something reconciles them.
 *
 * This job lists orders at status_id 4 (Refunded) or 14 (Partially Refunded),
 * reads each order's refunds, resolves them to product_id/variant_id and
 * quantity, and restocks only the lines that are not already reconciled and
 * not flagged as damaged, lost, or return-not-received. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/refund-does-not-restock-inventory/
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const LEDGER_PATH = process.env.LEDGER_PATH || "reconciled_refunds.json";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REFUNDED = 4;
const PARTIALLY_REFUNDED = 14;

const NON_RESTOCKABLE_MARKERS = ["damaged", "lost", "return not received", "not returned"];

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * refundedLines: [{refund_item_id, order_id, product_id, variant_id, quantity}]
 * reconciledLedger: Set of refund_item_id already compensated in a prior run.
 * skipFlags: refund_item_id -> true if the order/line is flagged non-restockable
 * (damaged, lost, or return not received).
 *
 * Returns one adjustment per line that is unreconciled and not flagged, with
 * adjustment equal to quantity (always > 0). Lines with a non-positive
 * quantity are skipped defensively.
 */
export function computeRestockAdjustments(refundedLines, reconciledLedger, skipFlags) {
  const adjustments = [];
  for (const line of refundedLines) {
    const refundItemId = line.refund_item_id;
    if (reconciledLedger.has(refundItemId)) continue;
    if (skipFlags[refundItemId]) continue;
    const quantity = line.quantity;
    if (quantity <= 0) continue;
    adjustments.push({
      product_id: line.product_id,
      variant_id: line.variant_id ?? null,
      adjustment: quantity,
      refund_item_id: refundItemId,
      order_id: line.order_id,
    });
  }
  return adjustments;
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

async function bcPut(base, path, body) {
  const res = await fetch(`${base}${path}`, {
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
    const orders = await bcGet(API_BASE_V2, "/orders", {
      status_id: `${REFUNDED},${PARTIALLY_REFUNDED}`,
      min_date_created: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderRefunds(orderId) {
  const data = await bcGet(API_BASE_V3, `/orders/${orderId}/payment_actions/refunds`);
  if (Array.isArray(data)) return data;
  return data.data || [];
}

async function orderProducts(orderId) {
  return bcGet(API_BASE_V2, `/orders/${orderId}/products`);
}

async function orderIsFlaggedNonRestockable(orderId) {
  const order = (await bcGet(API_BASE_V2, `/orders/${orderId}`)) || {};
  const staffNotes = (order.staff_notes || "").toLowerCase();
  const customerMessage = (order.customer_message || "").toLowerCase();
  const combined = `${staffNotes} ${customerMessage}`;
  return NON_RESTOCKABLE_MARKERS.some((marker) => combined.includes(marker));
}

async function resolveRefundedLines(orderId) {
  const refunds = await orderRefunds(orderId);
  const products = (await orderProducts(orderId)) || [];
  const productsByItemId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  for (const refund of refunds) {
    for (const item of refund.items || []) {
      if (item.item_type !== "PRODUCT") continue;
      const orderProduct = productsByItemId.get(item.item_id);
      if (!orderProduct) continue;
      lines.push({
        refund_item_id: `${refund.id}:${item.item_id}`,
        order_id: orderId,
        product_id: orderProduct.product_id,
        variant_id: orderProduct.variant_id,
        quantity: item.quantity || 0,
      });
    }
  }
  return lines;
}

async function applyAdjustment(adjustment) {
  const body = {
    reason: "refund-restock-reconciliation",
    items: [{
      product_id: adjustment.product_id,
      variant_id: adjustment.variant_id,
      adjustment: adjustment.adjustment,
    }],
  };
  return bcPut(API_BASE_V3, "/inventory/adjustments/relative", body);
}

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return new Set();
  return new Set(JSON.parse(readFileSync(LEDGER_PATH, "utf8")));
}

function saveLedger(ledger) {
  writeFileSync(LEDGER_PATH, JSON.stringify([...ledger].sort()));
}

export async function run() {
  const ledger = loadLedger();
  let restocked = 0;
  let skippedFlagged = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const lines = await resolveRefundedLines(orderId);
    if (!lines.length) continue;

    const flagged = await orderIsFlaggedNonRestockable(orderId);
    const skipFlags = {};
    for (const line of lines) skipFlags[line.refund_item_id] = flagged;
    if (flagged) skippedFlagged += lines.length;

    const adjustments = computeRestockAdjustments(lines, ledger, skipFlags);

    for (const adjustment of adjustments) {
      console.log(
        `product_id=${adjustment.product_id} variant_id=${adjustment.variant_id} ` +
        `order_id=${adjustment.order_id} refund_item_id=${adjustment.refund_item_id} ` +
        `adjustment=${adjustment.adjustment} (${DRY_RUN ? "dry run" : "restocking"})`
      );
      if (!DRY_RUN) {
        await applyAdjustment(adjustment);
        ledger.add(adjustment.refund_item_id);
      }
      restocked += 1;
    }
  }

  if (!DRY_RUN) saveLedger(ledger);

  console.log(
    `Done. ${restocked} line(s) ${DRY_RUN ? "to restock" : "restocked"}, ` +
    `${skippedFlagged} line(s) skipped as flagged non-restockable.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
