/**
 * Drop duplicate BigCommerce store/order/statusUpdated events fired in the same second.
 *
 * BigCommerce's webhook service guarantees at-least-once delivery, not exactly-once.
 * If your endpoint is slow, times out, or its 200 OK response is lost in transit, the
 * retry mechanism re-sends the same logical event. Separately, a single admin or API
 * action can legitimately trigger more than one webhook subscription in the same
 * second, and each carries its own created_at and a hash that is not guaranteed
 * stable, so hash alone cannot prove a duplicate. This script keeps a short-lived
 * idempotency store keyed on (resourceId, newStatusId) with createdAt rounded into
 * a window, drops repeats inside that window, confirms the order's real state with
 * GET /v2/orders/{id} when needed, and separately checks GET /v3/hooks for a
 * duplicate hook registration on the same scope and destination, a common
 * misconfiguration that doubles every delivery. It never writes to order state.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/webhook-duplicate-events-same-second/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}`;
const DEDUPE_WINDOW_SECONDS = Number(process.env.DEDUPE_WINDOW_SECONDS || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const WATCHED_SCOPE = "store/order/statusUpdated";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * seenEvents is a Map from "resourceId:newStatusId" to the last-seen createdAt
 * epoch for that key. If a prior entry exists within windowSeconds of the new
 * event, it is a duplicate: return true and leave the map untouched. Otherwise
 * record createdAtEpoch for the key and return false, meaning the event should
 * be processed. A different newStatusId for the same resourceId is treated as
 * a distinct event, never a duplicate of the other status.
 */
export function isDuplicateWebhookEvent(
  seenEvents, resourceId, newStatusId, createdAtEpoch, windowSeconds = DEDUPE_WINDOW_SECONDS
) {
  const key = `${resourceId}:${newStatusId}`;
  const lastSeen = seenEvents.get(key);
  if (lastSeen !== undefined && Math.abs(createdAtEpoch - lastSeen) <= windowSeconds) {
    return true;
  }
  seenEvents.set(key, createdAtEpoch);
  return false;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
}

/** Confirm the authoritative order state instead of trusting the payload alone. */
export async function fetchOrderState(orderId) {
  const order = await bcGet(`/v2/orders/${orderId}`);
  return { statusId: order.status_id, dateModified: order.date_modified };
}

/**
 * List /v3/hooks and return every active hook matching scope and destination,
 * oldest id first. More than one entry means every delivery to that destination
 * is doubled by configuration, not by a retry.
 */
export async function findDuplicateHooks(scope, destination) {
  const hooks = await bcGet("/v3/hooks");
  const data = Array.isArray(hooks) ? hooks : hooks.data || [];
  const matches = data.filter((h) => h.scope === scope && h.destination === destination);
  matches.sort((a, b) => (a.id || 0) - (b.id || 0));
  return matches;
}

/**
 * Process one inbound store/order/statusUpdated payload. Returns "processed" or
 * "dropped_duplicate". Never mutates order state: the order's status_id was
 * already applied correctly by BigCommerce, the bug being guarded against is
 * redundant notification delivery.
 */
export function handleWebhookEvent(seenEvents, payload) {
  const resourceId = payload.data.id;
  const newStatusId = payload.data.status.new_status_id;
  const createdAtEpoch = payload.created_at;
  const eventHash = payload.hash;

  if (isDuplicateWebhookEvent(seenEvents, resourceId, newStatusId, createdAtEpoch)) {
    console.log(
      `Duplicate dropped. resource_id=${resourceId} new_status_id=${newStatusId} created_at=${createdAtEpoch} hash=${eventHash}`
    );
    return "dropped_duplicate";
  }

  console.log(
    `Processing event. resource_id=${resourceId} new_status_id=${newStatusId} created_at=${createdAtEpoch} hash=${eventHash}`
  );
  return "processed";
}

export async function run(destinationUrl = process.env.WEBHOOK_DESTINATION_URL || "https://example.com/webhooks/bigcommerce") {
  const duplicateHooks = await findDuplicateHooks(WATCHED_SCOPE, destinationUrl);

  if (duplicateHooks.length <= 1) {
    console.log(`No duplicate hook registration found for scope=${WATCHED_SCOPE} destination=${destinationUrl}`);
    return;
  }

  const keep = duplicateHooks[0];
  const redundant = duplicateHooks.slice(1);
  console.warn(
    `Found ${duplicateHooks.length} hooks on scope=${WATCHED_SCOPE} destination=${destinationUrl}. ` +
    `Keeping id=${keep.id}, redundant ids=${redundant.map((h) => h.id)}`
  );

  for (const hook of redundant) {
    if (!DRY_RUN) {
      await bcDelete(`/v3/hooks/${hook.id}`);
      console.log(`Deleted redundant hook id=${hook.id}`);
    } else {
      console.log(`Dry run: would delete redundant hook id=${hook.id}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
