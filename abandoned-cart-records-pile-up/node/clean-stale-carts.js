/**
 * Find and safely clean up BigCommerce cart records that have piled up.
 *
 * A BigCommerce V3 cart, created via the Storefront or Management Cart API,
 * never expires and never self-deletes on the server. It persists indefinitely
 * until it either converts to an order or is explicitly deleted through the
 * API. Guest checkouts, abandoned-cart-recovery emails, headless storefront
 * sessions, and app integrations all create carts liberally, and the
 * "abandoned" definition (one hour of inactivity) only triggers a recovery
 * email, never any cleanup. Stores end up with a growing pile of stale,
 * empty, or orphaned cart records with no built-in garbage collection.
 *
 * This pages GET /v3/carts, reads each cart's age and line item counts,
 * cross-checks GET /v2/orders to see if the cart actually converted through a
 * different path, and classifies each cart with a pure function into
 * empty_cart, converted_duplicate, abandoned_stale, or active. Only
 * empty_cart and converted_duplicate are ever hard deleted with
 * DELETE /v3/carts/{cartId}. abandoned_stale carts, which still have real
 * items and no confirmed order, are only ever flagged for review, never
 * auto-deleted. Guarded by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/abandoned-cart-records-pile-up/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "dummy_store_hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const STALE_DAYS = parseInt(process.env.STALE_DAYS || "30", 10);

const SAFE_DELETE_REASONS = new Set(["empty_cart", "converted_duplicate"]);

/**
 * Pure decision logic, no network calls.
 *
 * cart: {id, customerId, email, createdTime, updatedTime, lineItemCounts:
 *   {physical, digital, custom, giftCert}}
 * matchingOrderExists: boolean
 * nowIso: string
 * staleDays: number
 *
 * - empty_cart: no line items at all, past the stale threshold. Safe to hard delete.
 * - converted_duplicate: a matching order exists regardless of age. Safe to hard
 *   delete, it is an orphaned leftover from a checkout that completed elsewhere.
 * - abandoned_stale: real items, past the stale threshold, no matching order.
 *   Flag only, never auto-delete, since it may be a cart a shopper still expects.
 * - active: everything else.
 */
export function classifyStaleCart(cart, matchingOrderExists, nowIso, staleDays = 30) {
  const updated = new Date(cart.updatedTime);
  const now = new Date(nowIso);
  const ageDays = (now - updated) / 86400000;

  const counts = cart.lineItemCounts;
  const totalItems = counts.physical + counts.digital + counts.custom + counts.giftCert;

  if (totalItems === 0 && ageDays > staleDays) {
    return { isStale: true, reason: "empty_cart" };
  }
  if (matchingOrderExists) {
    return { isStale: true, reason: "converted_duplicate" };
  }
  if (totalItems > 0 && ageDays > staleDays && !matchingOrderExists) {
    return { isStale: true, reason: "abandoned_stale" };
  }
  return { isStale: false, reason: "active" };
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

async function* allCarts() {
  const limit = 250;
  let page = 1;
  while (true) {
    const body = (await bc("GET", `/v3/carts?limit=${limit}&page=${page}`)) || {};
    const batch = body.data || [];
    if (!batch.length) return;
    for (const cart of batch) yield cart;
    const pagination = (body.meta || {}).pagination || {};
    if (page >= (pagination.total_pages || page)) return;
    page += 1;
  }
}

async function hasMatchingOrder(customerId, minDateCreated) {
  if (!customerId) return false;
  const qs = `customer_id=${customerId}&min_date_created=${minDateCreated}&limit=1`;
  const orders = (await bc("GET", `/v2/orders?${qs}`)) || [];
  return orders.length > 0;
}

function lineItemCounts(cart) {
  const items = cart.line_items || {};
  return {
    physical: (items.physical_items || []).length,
    digital: (items.digital_items || []).length,
    custom: (items.custom_items || []).length,
    giftCert: (items.gift_certificates || []).length,
  };
}

function normalizeCart(cart) {
  return {
    id: cart.id,
    customerId: cart.customer_id,
    email: cart.email,
    createdTime: cart.created_time,
    updatedTime: cart.updated_time,
    lineItemCounts: lineItemCounts(cart),
  };
}

async function deleteCart(cartId) {
  // Hard delete. Only ever called for a safe-delete reason.
  await bc("DELETE", `/v3/carts/${cartId}`);
}

async function flagCartForReview(cartId, updatedTime) {
  // Tag a real abandoned cart for review. Never deletes it.
  await bc("POST", `/v3/carts/${cartId}/metafields`, {
    key: "stale", value: "true", namespace: "cart_cleanup", permission_set: "write",
  });
  await bc("POST", `/v3/carts/${cartId}/metafields`, {
    key: "staleSince", value: updatedTime, namespace: "cart_cleanup", permission_set: "write",
  });
}

export async function run() {
  const nowIso = new Date().toISOString();
  let deleted = 0;
  let flagged = 0;

  for await (const rawCart of allCarts()) {
    const cart = normalizeCart(rawCart);
    const matchingOrderExists = await hasMatchingOrder(cart.customerId, cart.createdTime);
    const result = classifyStaleCart(cart, matchingOrderExists, nowIso, STALE_DAYS);

    if (!result.isStale) continue;

    if (SAFE_DELETE_REASONS.has(result.reason)) {
      console.log(`Cart ${cart.id} reason=${result.reason}. ${DRY_RUN ? "would delete" : "deleting"}`);
      if (!DRY_RUN) await deleteCart(cart.id);
      deleted++;
    } else {
      console.log(`Cart ${cart.id} reason=${result.reason} staleSince=${cart.updatedTime}. ${DRY_RUN ? "would flag" : "flagging"}`);
      if (!DRY_RUN) await flagCartForReview(cart.id, cart.updatedTime);
      flagged++;
    }
  }

  console.log(`Done. ${deleted} cart(s) ${DRY_RUN ? "to delete" : "deleted"}, ${flagged} cart(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
