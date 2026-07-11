/**
 * Resolve a BigCommerce order status name to its status_id before writing it.
 *
 * BigCommerce's V2 Orders resource models order state as a numeric status_id.
 * The status field returned by GET /v2/orders/{id}, for example "Awaiting
 * Fulfillment", is a read-only label the server computes from that id and the
 * store's Control Panel status-label customization. It is not an independent
 * writable property. Sending PUT /v2/orders/{id} with {"status": "Shipped"}
 * either gets silently ignored, leaving status_id unchanged, or gets rejected
 * if the endpoint validates strictly. It never maps the label back to an id.
 *
 * This job fetches the store's own GET /v2/order_statuses list, builds a
 * case-insensitive name-to-id map, resolves the desired status (a number or a
 * name) through that map with resolveStatusId, and writes only status_id,
 * never the raw string. Every write is checked against an explicit allowlist
 * of permitted target status ids, and every write is verified by re-fetching
 * the order and retried once on mismatch before being flagged for review.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-status-write-requires-status-id/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ALLOWED_STATUS_IDS = new Set(
  (process.env.ALLOWED_STATUS_IDS || "2,9,10,11")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
);

const VALID_STATUS_IDS = new Set(Array.from({ length: 15 }, (_, i) => i));

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * If desired is already a number (or a numeric string), return it only if it
 * is in validIds, else null. If desired is a text label, normalize
 * (trim/lowercase) and look it up in statusMap (built from name,
 * system_label, custom_label on GET /v2/order_statuses); return the matched
 * id, or null if there is no case-insensitive match. Never returns a string.
 * Callers must treat null as "do not write," not as a signal to fall back to
 * sending the raw label.
 */
export function resolveStatusId(desired, statusMap, validIds = VALID_STATUS_IDS) {
  if (typeof desired === "boolean") return null;
  if (typeof desired === "number" && Number.isInteger(desired)) {
    return validIds.has(desired) ? desired : null;
  }
  if (typeof desired === "string") {
    const stripped = desired.trim();
    if (/^-?\d+$/.test(stripped)) {
      const candidate = Number.parseInt(stripped, 10);
      return validIds.has(candidate) ? candidate : null;
    }
    const match = statusMap[stripped.toLowerCase()];
    return match === undefined ? null : match;
  }
  return null;
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

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function fetchStatusMap() {
  // Returns { loweredLabel: statusId } built from GET /v2/order_statuses
  const statuses = await bcGet("/order_statuses");
  const statusMap = {};
  for (const entry of statuses || []) {
    const statusId = entry.id;
    if (statusId === undefined || statusId === null) continue;
    for (const label of [entry.name, entry.system_label, entry.custom_label]) {
      if (label) statusMap[label.trim().toLowerCase()] = statusId;
    }
  }
  return statusMap;
}

async function writeStatusId(orderId, targetStatusId, attempt = 1, maxAttempts = 2) {
  await bcPut(`/orders/${orderId}`, { status_id: targetStatusId });
  const updated = await bcGet(`/orders/${orderId}`);
  if (updated.status_id === targetStatusId) return true;
  if (attempt < maxAttempts) return writeStatusId(orderId, targetStatusId, attempt + 1, maxAttempts);
  return false;
}

export async function run(orderId, desiredStatus) {
  const statusMap = await fetchStatusMap();
  const resolved = resolveStatusId(desiredStatus, statusMap);

  if (resolved === null) {
    console.warn(
      `order_id=${orderId} desired=${JSON.stringify(desiredStatus)} did not resolve to a known status_id, skipping write`
    );
    return;
  }

  if (!ALLOWED_STATUS_IDS.has(resolved)) {
    console.warn(
      `order_id=${orderId} resolved status_id=${resolved} is not in ALLOWED_STATUS_IDS=[${[...ALLOWED_STATUS_IDS].sort()}], flagging for review`
    );
    return;
  }

  const current = await bcGet(`/orders/${orderId}`);
  const fromStatusId = current.status_id;

  console.log(
    `order_id=${orderId} from_status_id=${fromStatusId} to_status_id=${resolved} (${DRY_RUN ? "dry run" : "writing"})`
  );

  if (DRY_RUN) return;

  if (fromStatusId === resolved) {
    console.log(`order_id=${orderId} already at status_id=${resolved}, no write needed`);
    return;
  }

  const ok = await writeStatusId(orderId, resolved);
  if (ok) {
    console.log(`order_id=${orderId} verified at status_id=${resolved}`);
  } else {
    console.warn(`order_id=${orderId} status_id mismatch after write and retry, flagging for manual review`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const orderId = process.env.ORDER_ID;
  const desiredStatus = process.env.DESIRED_STATUS || "Shipped";
  if (orderId) {
    run(Number(orderId), desiredStatus).catch((err) => { console.error(err); process.exit(1); });
  } else {
    console.log("Set ORDER_ID and DESIRED_STATUS to run against a real order.");
  }
}
