/**
 * Classify BigCommerce webhook deliveries so a handler never processes a resend twice.
 *
 * BigCommerce's dispatcher does not guarantee exactly-once delivery: a slow or non-2xx
 * endpoint gets the identical payload retried for up to about 48 hours, up to 11 attempts,
 * before the hook's is_active is set to false. Duplicate active hook registrations for the
 * same scope and destination also fan out one logical event into several deliveries. This
 * computes a delivery id from hash, created_at, scope, and producer (the payload has no
 * dedicated delivery id), skips anything already seen, and flags scopes where more than one
 * active hook would explain the duplicates. Also finds and, when confirmed, deactivates the
 * extra hooks. Run on a schedule for the hook scan. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/duplicate-webhook-deliveries-run-twice/
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const WATCHED_SCOPES = (process.env.WATCHED_SCOPES || "store/order/updated")
  .split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No network calls.
 * payload: { scope: string, hash: string, created_at: number, producer: string }
 * seenDeliveryIds: a ReadonlySet of delivery ids already processed
 * activeHooksForScope: count of active hooks sharing this scope + destination
 */
export function classifyWebhookDelivery(payload, seenDeliveryIds, activeHooksForScope) {
  const raw = `${payload.hash}|${payload.created_at}|${payload.scope}|${payload.producer}`;
  const deliveryId = createHash("sha256").update(raw).digest("hex");
  if (activeHooksForScope > 1) return { deliveryId, action: "flag_fanout" };
  if (seenDeliveryIds.has(deliveryId)) return { deliveryId, action: "skip_duplicate" };
  return { deliveryId, action: "process" };
}

export function handleDelivery(payload, seenDeliveryIds, activeHooksForScope, processFn) {
  const result = classifyWebhookDelivery(payload, seenDeliveryIds, activeHooksForScope);
  if (result.action !== "process") {
    console.log(`Delivery ${result.deliveryId.slice(0, 12)} ${result.action}, not reprocessing.`);
    return false;
  }
  seenDeliveryIds.add(result.deliveryId);
  processFn(payload);
  return true;
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

async function activeHooksForScope(scope) {
  const resp = await bc("GET", `/v3/hooks?scope=${scope}&limit=250`);
  return (resp?.data || []).filter((h) => h.is_active);
}

async function duplicateFanoutGroups(scope) {
  const byDestination = new Map();
  for (const hook of await activeHooksForScope(scope)) {
    const list = byDestination.get(hook.destination) || [];
    list.push(hook);
    byDestination.set(hook.destination, list);
  }
  const result = {};
  for (const [dest, hooks] of byDestination) {
    if (hooks.length > 1) result[dest] = hooks;
  }
  return result;
}

async function deactivateHook(hookId) {
  return bc("PUT", `/v3/hooks/${hookId}`, { is_active: false });
}

export async function run() {
  let flagged = 0;
  for (const scope of WATCHED_SCOPES) {
    const groups = await duplicateFanoutGroups(scope);
    for (const [destination, hooks] of Object.entries(groups)) {
      const sorted = [...hooks].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      const [keep, ...extras] = sorted;
      console.warn(
        `Scope ${scope} destination ${destination} has ${sorted.length} active hooks. Keeping id=${keep.id}, ${DRY_RUN ? "would deactivate" : "deactivating"}: ${extras.map((h) => h.id)}`
      );
      if (!DRY_RUN) {
        for (const hook of extras) await deactivateHook(hook.id);
      }
      flagged += extras.length;
    }
  }
  console.log(`Done. ${flagged} duplicate hook(s) ${DRY_RUN ? "to deactivate" : "deactivated"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
