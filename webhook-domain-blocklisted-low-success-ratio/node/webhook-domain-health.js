/**
 * Detect a BigCommerce webhook domain at risk of being blocklisted.
 *
 * BigCommerce's webhook dispatcher tracks a rolling success versus failure
 * ratio per destination domain over a sliding 2-minute window, evaluated
 * only once at least 100 requests have landed in that window. If the ratio
 * drops below 90 percent, typically because the receiving endpoint is slow,
 * returning non-200s, or intermittently down, BigCommerce blocklists the
 * entire domain for 3 minutes, not just the failing hook. Because the block
 * is domain scoped, one flaky path (for example /webhooks/orders) can starve
 * delivery to an unrelated healthy hook (for example /webhooks/inventory) on
 * the same host. If the instability persists, the same webhook can also hit
 * the separate 48-hour / 11-retry exhaustion path and get permanently
 * deactivated (is_active=false).
 *
 * There is no safe API call to lift a domain blocklist or force a
 * redelivery, the 3-minute block self-expires and BigCommerce requeues
 * automatically, so this script never tries. It lists registered hooks with
 * GET /v3/hooks, correlates them against your own app's request log to
 * compute rolling success ratios per domain, reports any domain at risk and
 * any hook already deactivated, and makes exactly one kind of write:
 * re-enabling a hook with PUT /v3/hooks/{hook_id} and {"is_active": true},
 * and only after a synthetic health-check request to the destination
 * returns 200. Guarded by DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/webhook-domain-blocklisted-low-success-ratio/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MIN_SAMPLE = Number(process.env.MIN_SAMPLE || 100);
const SUCCESS_THRESHOLD = Number(process.env.SUCCESS_THRESHOLD || 0.90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure. No network, no side effects.
 *
 * windowRequests: list of {timestamp, domain, status_code} entries for a
 * single rolling 2-minute window, one per delivery attempt.
 * Returns, per domain, {domain, total, success_ratio, at_risk}.
 * success_ratio is null (and at_risk false) when total < minSample, matching
 * BigCommerce's rule that the ratio is not evaluated until 100 requests are
 * seen. at_risk is true only when total >= minSample and success_ratio < threshold.
 */
export function evaluateWebhookHealth(windowRequests, minSample = 100, threshold = 0.90) {
  const byDomain = new Map();
  for (const entry of windowRequests || []) {
    const domain = entry.domain;
    const bucket = byDomain.get(domain) || { total: 0, success: 0 };
    bucket.total += 1;
    if (entry.status_code >= 200 && entry.status_code < 300) bucket.success += 1;
    byDomain.set(domain, bucket);
  }

  const results = {};
  for (const [domain, bucket] of byDomain.entries()) {
    if (bucket.total < minSample) {
      results[domain] = { domain, total: bucket.total, success_ratio: null, at_risk: false };
      continue;
    }
    const ratio = bucket.success / bucket.total;
    results[domain] = { domain, total: bucket.total, success_ratio: ratio, at_risk: ratio < threshold };
  }
  return results;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
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

async function* listHooks() {
  let page = 1;
  while (true) {
    const payload = await bcGet("/hooks", { page, limit: 50 });
    const hooks = payload.data || [];
    if (!hooks.length) return;
    for (const hook of hooks) yield hook;
    const pagination = (payload.meta || {}).pagination || {};
    if (page >= (pagination.total_pages || page)) return;
    page += 1;
  }
}

async function healthCheckOk(destination) {
  try {
    const res = await fetch(destination, { method: "GET" });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function reenableHook(hookId, destination) {
  if (!(await healthCheckOk(destination))) {
    console.warn(`Skipping re-enable for hook ${hookId}, health check failed.`);
    return false;
  }
  if (DRY_RUN) {
    console.log(`DRY_RUN: would PUT /hooks/${hookId} {"is_active": true}`);
    return true;
  }
  await bcPut(`/hooks/${hookId}`, { is_active: true });
  console.log(`Re-enabled hook ${hookId} after passing health check.`);
  return true;
}

/**
 * Placeholder for your app's own request log lookup. BigCommerce exposes no
 * delivery-log or success-rate endpoint, so this must come from wherever
 * your receiving app records each webhook request's timestamp, destination
 * domain, and response status code. Replace with a real query.
 */
async function fetchRecentRequestLog() {
  return [];
}

export async function run() {
  const windowRequests = await fetchRecentRequestLog();
  const healthByDomain = evaluateWebhookHealth(windowRequests, MIN_SAMPLE, SUCCESS_THRESHOLD);

  let atRiskCount = 0;
  for (const result of Object.values(healthByDomain)) {
    if (!result.at_risk) continue;
    atRiskCount += 1;
    console.warn(
      `Domain ${result.domain} at risk of blocklisting. ` +
      `success_ratio=${result.success_ratio.toFixed(3)} total=${result.total}`
    );
  }

  let reenabled = 0;
  for await (const hook of listHooks()) {
    if (hook.is_active) continue;
    const hookId = hook.id;
    const destination = hook.destination;
    console.warn(
      `Hook ${hookId} is deactivated (is_active=false). destination=${destination} updated_at=${hook.updated_at}`
    );
    if (destination && (await reenableHook(hookId, destination))) {
      reenabled += 1;
    }
  }

  console.log(
    `Done. ${atRiskCount} domain(s) at risk, ${reenabled} hook(s) ${DRY_RUN ? "to re-enable" : "re-enabled"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
