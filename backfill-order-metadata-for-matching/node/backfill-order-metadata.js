/**
 * Backfill a reconciliation key onto legacy BigCommerce orders, safely.
 *
 * Orders placed before an ERP, marketplace, or order-management integration was
 * wired up were created without external_id, external_merchant_id, or
 * external_source, because those fields are only populated by whichever client
 * submits the order at creation time. BigCommerce treats external_merchant_id as
 * write-once (a PUT to change it returns a 400) and external_id behaves the same
 * way once the order already exists, so those fields cannot be safely rewritten
 * after the fact. This scans the pre-cutover window, matches each unmatched order
 * against an external export, and writes an idempotent reconciliation tag into
 * staff_notes instead, which stays mutable for the life of the order.
 * Run on a schedule or once per migration batch. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/backfill-order-metadata-for-matching/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const HEADERS = { "X-Auth-Token": TOKEN, "Accept": "application/json", "Content-Type": "application/json" };

const MIGRATION_CUTOFF = process.env.MIGRATION_CUTOFF || "2025-01-01T00:00:00+00:00";
const CUTOVER_DATE = process.env.CUTOVER_DATE || "2025-06-01T00:00:00+00:00";
const MATCH_CONFIDENCE_THRESHOLD = Number(process.env.MATCH_CONFIDENCE_THRESHOLD || 0.8);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const VOID_STATUS_IDS = new Set([0, 5, 6]); // Incomplete, Cancelled, Declined
const EXPECTED_SOURCE_TAGS = new Set(["M-MIG"]);

export function needsBackfill(order) {
  if (order.external_id) return false;
  if (order.external_merchant_id) return false;
  const source = order.external_source;
  if (source && EXPECTED_SOURCE_TAGS.has(source)) return false;
  return true;
}

/**
 * Pure decision logic. No I/O, fully testable with plain objects.
 *
 * order: object with at least status_id, staff_notes, external_id, external_merchant_id
 * candidateMatch: null, or object with external_id, source, confidence
 * nowIso: an ISO 8601 timestamp string
 */
export function decideBackfillAction(order, candidateMatch, nowIso) {
  if (VOID_STATUS_IDS.has(order.status_id)) {
    return { action: "skip", reason: "incomplete_or_voided" };
  }

  const existingNotes = order.staff_notes || "";
  if (existingNotes.includes("[RECON:")) {
    return { action: "skip", reason: "already_tagged" };
  }

  if (order.external_id || order.external_merchant_id) {
    return { action: "skip", reason: "already_has_external_key" };
  }

  if (!candidateMatch || (candidateMatch.confidence || 0) < MATCH_CONFIDENCE_THRESHOLD) {
    return {
      action: "flag_unmatched",
      new_staff_notes: `${existingNotes}\n[RECON:UNMATCHED;checked=${nowIso}]`,
    };
  }

  return {
    action: "write_staff_notes",
    new_staff_notes:
      `${existingNotes}\n[RECON:ext_id=${candidateMatch.external_id};` +
      `source=${candidateMatch.source || "M-MIG"};matched=${nowIso}]`,
  };
}

async function bcGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(BASE + path + (qs ? `?${qs}` : ""), { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcPut(path, body) {
  const res = await fetch(BASE + path, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function scanCandidateOrders() {
  const orders = await bcGet("v2/orders", {
    min_date_created: MIGRATION_CUTOFF,
    max_date_created: CUTOVER_DATE,
    is_deleted: "false",
    sort: "id",
    limit: 250,
  });
  const out = [];
  for (const stub of orders) {
    const full = await bcGet(`v2/orders/${stub.id}`);
    if (needsBackfill(full)) out.push(full);
  }
  return out;
}

function findCandidateMatch(order, erpExport) {
  return erpExport[order.id] || null;
}

async function applyStaffNotes(orderId, newStaffNotes) {
  const fresh = await bcGet(`v2/orders/${orderId}`);
  if ((fresh.staff_notes || "").includes("[RECON:")) {
    return; // another run already tagged it, idempotent no-op
  }
  return bcPut(`v2/orders/${orderId}`, { staff_notes: newStaffNotes });
}

export async function run(erpExport = {}) {
  const nowIso = new Date().toISOString();

  let written = 0;
  let unmatched = 0;
  let skipped = 0;
  for (const order of await scanCandidateOrders()) {
    const candidateMatch = findCandidateMatch(order, erpExport);
    const decision = decideBackfillAction(order, candidateMatch, nowIso);

    if (decision.action === "skip") {
      skipped++;
      continue;
    }

    console.log(`Order ${order.id} -> ${decision.action}. ${DRY_RUN ? "would write" : "writing"}`);
    if (!DRY_RUN) await applyStaffNotes(order.id, decision.new_staff_notes);

    if (decision.action === "write_staff_notes") written++;
    else unmatched++;
  }

  console.log(`Done. ${written} order(s) ${DRY_RUN ? "to reconcile" : "reconciled"}, ${unmatched} flagged unmatched, ${skipped} skipped.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
