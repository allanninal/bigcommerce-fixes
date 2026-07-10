/**
 * Reconcile BigCommerce orders whose shipped quantity does not add up.
 *
 * An order's status_id is rolled up from summing quantity_shipped across its
 * line items on GET /v2/orders/{id}/products. Shipments are created in batches
 * through POST /v2/orders/{id}/shipments, so a duplicated call, a shipment
 * posted against an already-refunded line, or a dropped webhook retry can push
 * the shipped total above or leave it below the true ordered quantity. This
 * reads each candidate order's line items and its independent shipment ledger,
 * classifies the mismatch with classifyShipmentMismatch, safely corrects the
 * status_id for the two well-defined stuck-partial cases, and flags every other
 * mismatch to staff_notes for a human to reconcile against the WMS. It never
 * deletes, edits, or recreates a shipment record. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/partial-shipment-total-mismatch/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const MIN_DATE_MODIFIED = process.env.MIN_DATE_MODIFIED || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CANDIDATE_STATUS_IDS = new Set([2, 3, 14]);
const CORRECTED_STATUS_ID = { stuck_partial_done: 2, stuck_partial_unshipped: 11 };
const AUTO_CORRECT_VERDICTS = new Set(Object.keys(CORRECTED_STATUS_ID));

/**
 * Pure decision logic, no I/O. Returns one of:
 *   "ledger_drift"            BC's cached quantity_shipped disagrees with the sum of shipment records (case a)
 *   "over_fulfilled"          shipped + refunded exceeds what was ordered (case b)
 *   "stuck_partial_done"      fully shipped per ledger but status_id still 3 (case c)
 *   "stuck_partial_unshipped" nothing shipped/refunded but status_id is 3 (case d)
 *   "ok"                      no mismatch detected
 *
 * Precedence: ledger_drift and over_fulfilled (data integrity issues) take priority
 * over the status-only issues (c/d), which are safe to auto-correct.
 */
export function classifyShipmentMismatch(orderedQty, quantityShipped, quantityRefunded,
                                          shipmentLedgerQty, orderStatusId) {
  if (shipmentLedgerQty !== quantityShipped) return "ledger_drift";
  if (quantityShipped + quantityRefunded > orderedQty) return "over_fulfilled";
  if (orderStatusId === 3 && quantityShipped === orderedQty) return "stuck_partial_done";
  if (orderStatusId === 3 && quantityShipped === 0 && quantityRefunded === 0) return "stuck_partial_unshipped";
  return "ok";
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
      if (CANDIDATE_STATUS_IDS.has(Number(row.status_id))) yield row;
    }
    page++;
  }
}

async function orderLineItems(orderId) {
  return (await bc("GET", `/v2/orders/${orderId}/products`)) || [];
}

async function shipmentLedgerByLine(orderId) {
  const shipments = (await bc("GET", `/v2/orders/${orderId}/shipments`)) || [];
  const totals = {};
  for (const shipment of shipments) {
    for (const item of shipment.items || []) {
      const key = item.order_product_id;
      totals[key] = (totals[key] || 0) + Number(item.quantity);
    }
  }
  return totals;
}

async function correctStatus(orderId, verdict) {
  return bc("PUT", `/v2/orders/${orderId}`, { status_id: CORRECTED_STATUS_ID[verdict] });
}

async function flagForReview(orderId, verdict, lineSummary) {
  const note = `SHIPMENT_MISMATCH[${verdict}]: ${lineSummary}`;
  return bc("PUT", `/v2/orders/${orderId}`, { staff_notes: note });
}

export async function run() {
  let corrected = 0;
  let flagged = 0;
  for await (const row of ordersToCheck()) {
    const orderId = row.id;
    const statusId = Number(row.status_id);
    const ledger = await shipmentLedgerByLine(orderId);
    const lines = await orderLineItems(orderId);
    for (const line of lines) {
      const lineId = line.id;
      const orderedQty = Number(line.quantity);
      const quantityShipped = Number(line.quantity_shipped || 0);
      const quantityRefunded = Number(line.quantity_refunded || 0);
      const ledgerQty = ledger[lineId] || 0;
      const verdict = classifyShipmentMismatch(
        orderedQty, quantityShipped, quantityRefunded, ledgerQty, statusId
      );
      if (verdict === "ok") continue;
      const summary = `order=${orderId} line=${lineId} ordered=${orderedQty} shipped=${quantityShipped} refunded=${quantityRefunded} ledger=${ledgerQty} status_id=${statusId}`;
      if (AUTO_CORRECT_VERDICTS.has(verdict)) {
        console.log(`${verdict}. ${summary} ${DRY_RUN ? "would correct" : "correcting"}`);
        if (!DRY_RUN) await correctStatus(orderId, verdict);
        corrected++;
      } else {
        console.warn(`${verdict}. ${summary} ${DRY_RUN ? "would flag" : "flagging"}`);
        if (!DRY_RUN) await flagForReview(orderId, verdict, summary);
        flagged++;
      }
    }
  }
  console.log(
    `Done. ${corrected} order(s) ${DRY_RUN ? "to correct" : "corrected"}, ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
