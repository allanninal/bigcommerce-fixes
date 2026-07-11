/**
 * Detect BigCommerce order webhooks that stopped firing with no surfaced error.
 *
 * BigCommerce retries a failing webhook destination on a backoff schedule for
 * roughly 48 hours, then permanently sets is_active to false on that
 * subscription, emailing only the address on file for the subscribing app.
 * Separately, once a destination domain has received 100 or more requests,
 * BigCommerce tracks a rolling 2 minute success and failure ratio and
 * blocklists the whole domain for 3 minutes if the success rate drops below
 * 90 percent, which can fail deliveries even on a hook that still reads
 * is_active:true. Neither mechanism raises a dashboard alert. This job pulls
 * recent orders, the store's current hook subscriptions, and the store's own
 * webhook receiver log, and reports any hook that is deactivated or has gone
 * stale with no recent delivery. It never auto-reactivates; repair is a
 * separate, guarded, dry-run-respecting step.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-webhooks-stop-firing-silently/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 1);
const STALE_AFTER_MINUTES = Number(process.env.STALE_AFTER_MINUTES || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function scopeMatches(scope) {
  return scope.startsWith("store/order/") || scope.startsWith("store/customer/");
}

/**
 * Pure decision. No network, no side effects.
 *
 * orderTimestamps: ISO8601 date_created/date_modified values from GET /v2/orders.
 * webhookLogTimestamps: {scope: [receivedAt ISO8601, ...]} from the store's own
 *   webhook receiver log.
 * hookRecords: raw items from GET /v3/hooks, each with id, scope, destination,
 *   is_active, updated_at.
 * now: ISO8601 current time, injected for testability.
 * staleAfterMinutes: threshold beyond normal delivery latency before a
 *   still-active hook counts as stale.
 *
 * Returns a list of finding objects: {hook_id, scope, destination, is_active, reason}
 * with reason in "deactivated" or "stale_no_recent_delivery".
 */
export function detectWebhookGap(orderTimestamps, webhookLogTimestamps, hookRecords, now, staleAfterMinutes = 30) {
  const findings = [];
  const nowMs = new Date(now).getTime();
  const orderMs = orderTimestamps.map((t) => new Date(t).getTime()).filter((t) => Number.isFinite(t));
  const latestOrder = orderMs.length ? Math.max(...orderMs) : null;

  for (const hook of hookRecords) {
    const scope = hook.scope || "";
    if (!scopeMatches(scope)) continue;

    if (hook.is_active === false) {
      findings.push({
        hook_id: hook.id,
        scope,
        destination: hook.destination,
        is_active: false,
        reason: "deactivated",
      });
      continue;
    }

    if (latestOrder === null) continue;

    const logTimes = (webhookLogTimestamps[scope] || [])
      .map((t) => new Date(t).getTime())
      .filter((t) => Number.isFinite(t));
    const lastReceived = logTimes.length ? Math.max(...logTimes) : null;

    const gapReference = lastReceived ?? latestOrder;
    const staleCutoff = nowMs - staleAfterMinutes * 60 * 1000;

    if (latestOrder > gapReference && gapReference < staleCutoff) {
      findings.push({
        hook_id: hook.id,
        scope,
        destination: hook.destination,
        is_active: true,
        reason: "stale_no_recent_delivery",
      });
    }
  }

  return findings;
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

async function recentOrders(lookbackDays) {
  const orders = [];
  let page = 1;
  while (true) {
    const batch = await bcGet(API_BASE_V2, "/orders", {
      min_date_created: `-${lookbackDays} days`,
      sort: "date_created:desc",
      page,
      limit: 50,
    });
    if (!batch.length) return orders;
    orders.push(...batch);
    page += 1;
  }
}

async function currentHooks() {
  const result = await bcGet(API_BASE_V3, "/hooks", { limit: 250 });
  return Array.isArray(result) ? result : result.data || [];
}

function loadWebhookLogTimestamps() {
  // Replace this with a real query against your receiver's storage. Left as
  // a stub here since the log table is store-specific infrastructure.
  return {};
}

async function reactivateHook(hookId) {
  if (DRY_RUN) {
    console.log(`DRY_RUN: would PUT /v3/hooks/${hookId} {"is_active": true}`);
    return null;
  }
  return bcPut(API_BASE_V3, `/hooks/${hookId}`, { is_active: true });
}

export async function run() {
  const orders = await recentOrders(LOOKBACK_DAYS);
  const orderTimestamps = orders.map((o) => o.date_modified || o.date_created).filter(Boolean);
  const hooks = await currentHooks();
  const webhookLogTimestamps = loadWebhookLogTimestamps();
  const now = new Date().toISOString();

  const findings = detectWebhookGap(orderTimestamps, webhookLogTimestamps, hooks, now, STALE_AFTER_MINUTES);

  for (const finding of findings) {
    console.warn(
      `webhook gap: hook_id=${finding.hook_id} scope=${finding.scope} destination=${finding.destination} is_active=${finding.is_active} reason=${finding.reason}`
    );
  }

  console.log(`Done. ${orders.length} order(s) checked, ${findings.length} hook finding(s).`);
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
