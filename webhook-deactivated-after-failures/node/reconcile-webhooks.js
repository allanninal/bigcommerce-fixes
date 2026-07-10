/**
 * Find and safely repair BigCommerce webhooks deactivated after failures.
 *
 * BigCommerce retries a failed delivery, any response that is not HTTP 2xx,
 * with exponential backoff for up to 11 attempts spanning roughly 48 hours.
 * If the destination never returns a 2xx in that window, BigCommerce sets
 * is_active to false on that hook and emails the app's registered address,
 * permanently pausing delivery. A hook can also be auto deactivated after
 * 90 days of zero triggered events. This lists every hook with GET /v3/hooks,
 * diffs it against a desired manifest of scope and destination pairs, health
 * checks the destination before reactivating, and recreates anything missing
 * entirely. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/webhook-deactivated-after-failures/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DESIRED_MANIFEST = process.env.DESIRED_WEBHOOKS_JSON || "[]";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No network calls.
 * desired: Array<{ scope, destination, is_active, headers? }>
 * live: Array<{ id, scope, destination, is_active }>
 * returns: { toReactivate: number[], toRecreate: desired[], toLeave: number[] }
 *
 * Order of iteration over `desired` is preserved in the outputs, and neither
 * input array is mutated.
 */
export function planWebhookReconciliation(desired, live) {
  const byKey = new Map(live.map((h) => [`${h.scope}::${h.destination}`, h]));
  const toReactivate = [];
  const toRecreate = [];
  const toLeave = [];
  for (const entry of desired) {
    const key = `${entry.scope}::${entry.destination}`;
    const match = byKey.get(key);
    if (!match) {
      toRecreate.push(entry);
    } else if (match.is_active) {
      toLeave.push(match.id);
    } else {
      toReactivate.push(match.id);
    }
  }
  return { toReactivate, toRecreate, toLeave };
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

async function listHooks() {
  let page = 1;
  const hooks = [];
  while (true) {
    const body = await bc("GET", `/v3/hooks?page=${page}&limit=50`);
    const rows = (body || {}).data || [];
    if (rows.length === 0) return hooks;
    for (const row of rows) {
      hooks.push({
        id: row.id,
        scope: row.scope,
        destination: row.destination,
        is_active: Boolean(row.is_active),
      });
    }
    const pagination = (body.meta || {}).pagination || {};
    if (page >= (pagination.total_pages || page)) return hooks;
    page++;
  }
}

async function getHook(hookId) {
  const body = await bc("GET", `/v3/hooks/${hookId}`);
  return (body || {}).data || {};
}

async function destinationIsHealthy(destination) {
  if (!destination.toLowerCase().startsWith("https://")) return false;
  try {
    const res = await fetch(destination, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

async function reactivateHook(hookId) {
  const body = await bc("PUT", `/v3/hooks/${hookId}`, { is_active: true });
  return (body || {}).data || {};
}

async function recreateHook(entry) {
  const payload = {
    scope: entry.scope,
    destination: entry.destination,
    is_active: true,
    headers: entry.headers || {},
  };
  const body = await bc("POST", "/v3/hooks", payload);
  return (body || {}).data || {};
}

export async function run() {
  const desired = JSON.parse(DESIRED_MANIFEST);
  const live = await listHooks();
  const plan = planWebhookReconciliation(desired, live);

  let reactivated = 0;
  let recreated = 0;
  let skipped = 0;

  for (const hookId of plan.toReactivate) {
    const hook = live.find((h) => h.id === hookId);
    const destination = hook ? hook.destination : null;
    const healthy = Boolean(destination) && (await destinationIsHealthy(destination));
    if (!healthy) {
      console.warn(`Hook ${hookId} destination not healthy yet, skipping reactivation.`);
      skipped++;
      continue;
    }
    console.log(`Hook ${hookId} healthy. ${DRY_RUN ? "would reactivate" : "reactivating"}`);
    if (!DRY_RUN) {
      await reactivateHook(hookId);
      const confirmed = await getHook(hookId);
      if (!confirmed.is_active) throw new Error(`Hook ${hookId} did not confirm active after PUT`);
    }
    reactivated++;
  }

  for (const entry of plan.toRecreate) {
    if (!entry.destination.toLowerCase().startsWith("https://")) {
      console.warn(`Refusing to recreate non-HTTPS destination ${entry.destination}`);
      skipped++;
      continue;
    }
    console.log(`Missing hook for ${entry.scope} ${entry.destination}. ${DRY_RUN ? "would recreate" : "recreating"}`);
    if (!DRY_RUN) {
      const created = await recreateHook(entry);
      const confirmed = created.id ? await getHook(created.id) : {};
      if (!confirmed.is_active) throw new Error(`New hook for ${entry.scope} did not confirm active`);
    }
    recreated++;
  }

  console.log(`Done. ${reactivated} to reactivate, ${recreated} to recreate, ${skipped} skipped, ${plan.toLeave.length} already healthy.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
