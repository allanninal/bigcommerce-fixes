/**
 * Find and safely clear BigCommerce webhooks orphaned by app or token removal.
 *
 * Uninstalling an app through the App Marketplace flow, or deleting an API
 * account through the control panel, cascades to delete that client_id's
 * webhooks. Every other way an app or token disappears, an ad-hoc token
 * revocation, a legacy store-level credential, or an app that never received
 * the store/app/uninstall event, leaves its webhooks fully intact and still
 * firing. GET /v3/hooks only returns hooks tied to the client_id of the
 * credential making the call, so no single request shows every webhook a
 * store has ever registered. This job lists hooks visible to the configured
 * credential, diffs each hook's client_id against a known-good set of
 * currently installed apps, and only deletes a hook when it is both unowned
 * and already deactivated by BigCommerce for a long stretch. A still active,
 * unrecognized hook is flagged for a human, never deleted automatically.
 * Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/orphaned-webhooks-after-token-removal/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const KNOWN_CLIENT_IDS = new Set(
  (process.env.KNOWN_CLIENT_IDS || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
);
const STALE_AFTER_DAYS = Number(process.env.STALE_AFTER_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * hook: {id, client_id, scope, destination, is_active, created_at, updated_at}
 * knownClientIds: Set of client_id strings for currently installed/authorized
 *   apps (or the single store-level client_id set the operator trusts).
 *
 * 1. If hook.client_id is in knownClientIds -> "keep".
 * 2. Else (client_id not recognized):
 *      a. If hook.is_active is false and (nowEpoch - hook.updated_at)
 *           > staleAfterDays*86400 -> "orphan_delete" (safe: already
 *           deactivated by BigCommerce AND unowned).
 *      b. Else if hook.is_active is true -> "orphan_flag_only" (still firing
 *           for an unrecognized owner; needs human confirm before delete).
 *      c. Else -> "stale_inactive" (recently deactivated, unrecognized owner,
 *           but not old enough to auto-clear).
 */
export function classifyHook(hook, knownClientIds, nowEpoch, staleAfterDays = 90) {
  if (knownClientIds.has(hook.client_id)) return "keep";

  const isActive = Boolean(hook.is_active);
  const updatedAt = hook.updated_at || 0;
  const ageSeconds = nowEpoch - updatedAt;
  const isStale = ageSeconds > staleAfterDays * 86400;

  if (!isActive && isStale) return "orphan_delete";
  if (isActive) return "orphan_flag_only";
  return "stale_inactive";
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

async function bcDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function* listHooks() {
  let page = 1;
  while (true) {
    const payload = await bcGet("/hooks", { page, limit: 50 });
    const items = payload.data || [];
    if (!items.length) return;
    for (const hook of items) yield hook;
    const nextLink = payload.meta?.pagination?.links?.next;
    if (!nextLink) return;
    page += 1;
  }
}

async function deleteHook(hookId) {
  return bcDelete(`/hooks/${hookId}`);
}

export async function run() {
  let deleted = 0;
  let flagged = 0;
  let stale = 0;
  const nowEpoch = Math.floor(Date.now() / 1000);

  for await (const hook of listHooks()) {
    const decision = classifyHook(hook, KNOWN_CLIENT_IDS, nowEpoch, STALE_AFTER_DAYS);

    if (decision === "keep") continue;

    if (decision === "stale_inactive") {
      console.log(
        `Hook ${hook.id} (client_id=${hook.client_id}) is recently inactive but not old enough to clear yet.`
      );
      stale += 1;
      continue;
    }

    if (decision === "orphan_flag_only") {
      console.warn(
        `Hook ${hook.id} flagged for review. client_id=${hook.client_id} scope=${hook.scope} ` +
        `destination=${hook.destination} is_active=${hook.is_active} created_at=${hook.created_at}`
      );
      flagged += 1;
      continue;
    }

    console.log(
      `id=${hook.id} client_id=${hook.client_id} scope=${hook.scope} destination=${hook.destination} ` +
      `is_active=${hook.is_active} created_at=${hook.created_at} (${DRY_RUN ? "dry run" : "deleting"})`
    );
    if (!DRY_RUN) await deleteHook(hook.id);
    deleted += 1;
  }

  console.log(
    `Done. ${deleted} hook(s) ${DRY_RUN ? "to delete" : "deleted"}, ${flagged} hook(s) flagged for review, ` +
    `${stale} hook(s) stale but not yet clearable.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
