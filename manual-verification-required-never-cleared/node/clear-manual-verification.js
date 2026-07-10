/**
 * Surface and clear BigCommerce orders stuck on Manual Verification Required.
 *
 * A fraud-screening app (FraudLabs Pro, NoFraud, Signifyd, Kount) or an ERP
 * connector writes status_id 12 to an order when it flags a REVIEW verdict.
 * The human review then happens inside that app's own dashboard, so nothing
 * tells BigCommerce the order was approved. This never auto-transitions an
 * order on elapsed time. It only reports orders that already carry an
 * explicit human-approval marker in staff_notes or messages, with a
 * non-declined transaction, and only writes when DRY_RUN=false.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/manual-verification-required-never-cleared/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const MIN_DATE_MODIFIED = process.env.MIN_DATE_MODIFIED || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MANUAL_VERIFICATION_STATUS_ID = 12;
const AWAITING_FULFILLMENT_STATUS_ID = 11;

const APPROVAL_RE = /\b(approved|cleared|verified)\b/i;
const DECLINED_TXN_STATUSES = new Set(["declined", "void"]);
const OK_TXN_STATUSES = new Set([null, undefined, "approved", "captured"]);

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pure decision logic, no I/O. Returns "clear", "hold", or "skip".
 *
 * - "skip": the order is not on status_id 12, nothing to do here.
 * - "hold": still needs a human, or the transaction looks unsafe to clear.
 * - "clear": an explicit human-approval marker was found in staff_notes or a
 *   message timestamped after date_modified, and the transaction is not
 *   declined or voided.
 */
export function decideClearable(order, messages, transactionStatus) {
  if (order.status_id !== MANUAL_VERIFICATION_STATUS_ID) return "skip";
  if (DECLINED_TXN_STATUSES.has(transactionStatus)) return "hold";

  const modifiedAt = parseDate(order.date_modified);
  let hasMarker = false;

  const note = order.staff_notes || "";
  if (APPROVAL_RE.test(note)) hasMarker = true;

  if (!hasMarker) {
    for (const msg of messages || []) {
      const text = msg.message || "";
      if (!APPROVAL_RE.test(text)) continue;
      const createdAt = parseDate(msg.date_created);
      if (modifiedAt === null || createdAt === null || createdAt >= modifiedAt) {
        hasMarker = true;
        break;
      }
    }
  }

  if (hasMarker && OK_TXN_STATUSES.has(transactionStatus)) return "clear";
  return "hold";
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

async function* ordersPendingVerification() {
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({ status_id: String(MANUAL_VERIFICATION_STATUS_ID), limit: "250", page: String(page) });
    if (MIN_DATE_MODIFIED) qs.set("min_date_modified", MIN_DATE_MODIFIED);
    const batch = (await bc("GET", `/v2/orders?${qs.toString()}`)) || [];
    if (batch.length === 0) return;
    for (const order of batch) yield order;
    if (batch.length < 250) return;
    page += 1;
  }
}

async function orderMessages(orderId) {
  return (await bc("GET", `/v2/orders/${orderId}/messages`)) || [];
}

async function transactionStatusFor(orderId) {
  const txns = (await bc("GET", `/v2/orders/${orderId}/transactions`)) || [];
  for (const t of txns) {
    const status = (t.status || "").toLowerCase();
    if (DECLINED_TXN_STATUSES.has(status)) return status;
  }
  for (const t of txns) {
    const status = (t.status || "").toLowerCase();
    if (status === "approved" || status === "captured") return status;
  }
  return null;
}

async function clearOrder(orderId) {
  await bc("PUT", `/v2/orders/${orderId}`, { status_id: AWAITING_FULFILLMENT_STATUS_ID });
  await bc("POST", `/v2/orders/${orderId}/messages`, {
    message: "Cleared Manual Verification Required to Awaiting Fulfillment "
      + "after finding an explicit staff approval marker and a non-declined transaction.",
    status_id: AWAITING_FULFILLMENT_STATUS_ID,
  });
}

export async function run() {
  let cleared = 0;
  let held = 0;
  for await (const order of ordersPendingVerification()) {
    const orderId = order.id;
    const fullOrder = (await bc("GET", `/v2/orders/${orderId}`)) || order;
    const messages = await orderMessages(orderId);
    const txnStatus = await transactionStatusFor(orderId);

    const decision = decideClearable(fullOrder, messages, txnStatus);
    if (decision === "skip") continue;
    if (decision === "hold") { held++; continue; }

    console.log(`Order ${orderId} clearable. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearOrder(orderId);
    cleared++;
  }
  console.log(`Done. ${cleared} order(s) ${DRY_RUN ? "to clear" : "cleared"}, ${held} held for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
