/**
 * Confirm BigCommerce inventory adjustments instead of trusting the write's 200.
 *
 * BigCommerce's Inventory API (PUT /v3/inventory/adjustments/absolute or /relative)
 * processes writes asynchronously. The call returns 200 with an action id (data.id)
 * as soon as the request is accepted into the processing pipeline, not after the new
 * quantity is durably committed and propagated to the read path. BigCommerce's own
 * docs describe this as eventual consistency: "there may be a short delay before
 * data is updated after the endpoints are called." A relative adjustment can even
 * race against a still-in-flight absolute adjustment's pre-check stage and apply
 * the pre-adjustment value. A GET immediately after a write can therefore return
 * the pre-write quantity with no error or signal that it is stale.
 *
 * This script submits an adjustment, then polls the read endpoint with exponential
 * backoff until the observed quantity matches the expected quantity. If the poll
 * budget runs out first, it flags the adjustment for an operator instead of ever
 * calling /v3/inventory/adjustments again. Re-submitting a write to "fix" a stale
 * read risks double-applying a relative delta or masking a real failure downstream.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/inventory-read-after-write-lag/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 6);
const BASE_DELAY_S = Number(process.env.BASE_DELAY_S || 1.0);
const MAX_DELAY_S = Number(process.env.MAX_DELAY_S || 60.0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Decide whether an inventory read confirms a prior write, and if not,
 * whether to retry or flag.
 *
 * Returns { status: "confirmed"|"retry"|"stale_flagged", nextDelayS: number|null, reason: string }
 *
 * if adjustmentId is null/undefined: status="stale_flagged", reason="missing action id, cannot confirm"
 * else if observedQuantity === expectedQuantity: status="confirmed"
 * else if attempt >= maxAttempts: status="stale_flagged", reason="poll budget exhausted"
 * else: status="retry", nextDelayS=min(baseDelayS * (2 ** attempt), maxDelayS)
 */
export function confirmInventoryWrite(
  expectedQuantity,
  observedQuantity,
  adjustmentId,
  attempt,
  maxAttempts,
  baseDelayS = 1.0,
  maxDelayS = 60.0,
) {
  if (adjustmentId === null || adjustmentId === undefined) {
    return {
      status: "stale_flagged",
      nextDelayS: null,
      reason: "missing action id, cannot confirm",
    };
  }
  if (observedQuantity === expectedQuantity) {
    return { status: "confirmed", nextDelayS: null, reason: "quantity matches" };
  }
  if (attempt >= maxAttempts) {
    return { status: "stale_flagged", nextDelayS: null, reason: "poll budget exhausted" };
  }
  const delay = Math.min(baseDelayS * 2 ** attempt, maxDelayS);
  return { status: "retry", nextDelayS: delay, reason: "quantity not yet confirmed" };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
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

async function submitAdjustment(mode, reason, sku, locationId, quantity) {
  // mode is "absolute" or "relative"
  const body = {
    reason,
    items: [{ sku, location_id: locationId, quantity }],
  };
  return bcPut(`/inventory/adjustments/${mode}`, body);
}

async function readItem(sku, locationId) {
  const data = await bcGet("/inventory/items", { location_ids: locationId, skus: sku });
  const rows = data.data || [];
  return rows.length ? rows[0] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmWrite(sku, locationId, expectedQuantity, adjustmentId) {
  const started = Date.now();
  let attempt = 0;
  let observed = null;
  while (true) {
    const item = await readItem(sku, locationId);
    observed = item ? item.available_to_sell : null;
    const decision = confirmInventoryWrite(
      expectedQuantity, observed, adjustmentId, attempt, MAX_ATTEMPTS,
      BASE_DELAY_S, MAX_DELAY_S,
    );
    if (decision.status !== "retry") {
      const elapsedMs = Date.now() - started;
      return { decision, observed, attempt, elapsedMs };
    }
    await sleep(decision.nextDelayS * 1000);
    attempt += 1;
  }
}

export async function run(
  sku = process.env.SKU || "example-sku",
  locationId = Number(process.env.LOCATION_ID || 1),
  expectedQuantity = Number(process.env.EXPECTED_QUANTITY || 0),
  mode = "absolute",
  reason = "stock recount",
) {
  console.log(
    `Submitting ${mode} adjustment sku=${sku} location_id=${locationId} ` +
    `expected_quantity=${expectedQuantity} (${DRY_RUN ? "dry run" : "writing"})`
  );

  if (DRY_RUN) {
    console.log("DRY_RUN=true, skipping the write and the confirmation poll.");
    return;
  }

  const response = await submitAdjustment(mode, reason, sku, locationId, expectedQuantity);
  const adjustmentId = response.data ? response.data.id : undefined;

  const { decision, observed, attempt, elapsedMs } = await confirmWrite(
    sku, locationId, expectedQuantity, adjustmentId
  );

  if (decision.status === "confirmed") {
    console.log(
      `Confirmed sku=${sku} location_id=${locationId} quantity=${observed} ` +
      `after ${attempt} attempt(s), ${elapsedMs}ms`
    );
    return;
  }

  const record = {
    adjustment_id: adjustmentId,
    sku,
    location_id: locationId,
    expected_quantity: expectedQuantity,
    last_observed_quantity: observed,
    attempts: attempt,
    elapsed_ms: elapsedMs,
  };
  console.warn("STALE_FLAGGED", record, "reason=", decision.reason);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
