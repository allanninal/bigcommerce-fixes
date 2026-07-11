/**
 * Find and safely clean up orphaned duplicate carts from the B2B Buyer Portal.
 *
 * BigCommerce carts are anonymous by default. A cart is created against a
 * storefront checkout/session cart_id and only gets a customer_id attached
 * when the shopper is logged in at the moment items are added, via a PUT to
 * /v3/carts/{cartId} or storefront session binding. The B2B Buyer Portal has
 * no reliable way to rehydrate a customer's prior cart on a new device or
 * after a fresh login, because the Carts API has no "list carts by
 * customer_id" endpoint, and the portal's SPA state and the storefront cart
 * cookie are both scoped to the browser. Login, logout, and device switches
 * therefore spawn a new anonymous cart_id, and the old cart is simply
 * abandoned until BigCommerce auto-expires it after 30 days without
 * modification.
 *
 * This job rebuilds a {cart_id, customer_id, created_at, updated_at} mapping
 * from your own tracked source, re-reads each cart's live state from the
 * Carts API, groups by customer_id, and classifies duplicates with a pure
 * function: the most recently updated cart is canonical, an older cart whose
 * items are a subset of the canonical cart is safely deletable, and an older
 * cart with items the canonical cart lacks is flagged for a manual merge,
 * never auto-merged or deleted. Deletion only happens when DRY_RUN is
 * explicitly turned off, because a deleted cart cannot be recovered.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/b2b-cart-not-persisted-across-sessions/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const CART_VALIDITY_DAYS = Number(process.env.CART_VALIDITY_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * carts: array of {cart_id, customer_id, updated_time, line_item_skus: Set}.
 *
 * Returns: {customerIdString: {canonical: cartId,
 * orphans_deletable: [cartId...], orphans_needs_merge: [cartId...]}}
 *
 * Decision logic (no I/O, pure):
 *   1. Drop expired carts where (nowEpoch - updated_time) > validityDays * 86400.
 *   2. Group remaining carts by customer_id (skip customer_id == 0 / null /
 *      undefined, anonymous carts are not duplicates by definition).
 *   3. Within each group with length > 1, canonical = cart with max(updated_time).
 *   4. For every non-canonical cart in the group:
 *      - if its line_item_skus is a subset of canonical's line_item_skus -> orphans_deletable
 *      - else -> orphans_needs_merge
 */
export function classifyCartDuplicates(carts, nowEpoch, validityDays = 30) {
  const live = carts.filter((c) => nowEpoch - c.updated_time <= validityDays * 86400);

  const byCustomer = new Map();
  for (const cart of live) {
    const cid = cart.customer_id;
    if (!cid) continue;
    const key = String(cid);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(cart);
  }

  const result = {};
  for (const [customerId, group] of byCustomer) {
    if (group.length <= 1) continue;
    const canonical = group.reduce((a, b) => (b.updated_time > a.updated_time ? b : a));
    const deletable = [];
    const needsMerge = [];
    for (const cart of group) {
      if (cart.cart_id === canonical.cart_id) continue;
      const isSubset = [...cart.line_item_skus].every((sku) => canonical.line_item_skus.has(sku));
      if (isSubset) deletable.push(cart.cart_id);
      else needsMerge.push(cart.cart_id);
    }
    result[customerId] = {
      canonical: canonical.cart_id,
      orphans_deletable: deletable,
      orphans_needs_merge: needsMerge,
    };
  }
  return result;
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

async function bcDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return true;
}

async function fetchCart(cartId) {
  // Returns null if the cart is already gone (expired or deleted).
  try {
    const resp = await bcGet(`/carts/${cartId}`);
    return resp.data || null;
  } catch (err) {
    if (String(err.message).includes("404")) return null;
    throw err;
  }
}

function lineItemSkus(cartData) {
  const lineItems = cartData.line_items || {};
  const physical = lineItems.physical_items || [];
  const digital = lineItems.digital_items || [];
  return new Set([...physical, ...digital].map((item) => item.sku).filter(Boolean));
}

async function activeCustomerIds(customerIds) {
  if (!customerIds.length) return new Set();
  const idsParam = customerIds.join(",");
  const resp = await bcGet("/customers", { "id:in": idsParam });
  return new Set((resp.data || []).map((row) => row.id));
}

/**
 * Replace this with your own store of tracked cart_ids. BigCommerce has no
 * endpoint to list carts, so this must come from your own checkout redirect
 * events, order logs, or webhook history captured at cart creation time.
 */
async function loadTrackedCartIds() {
  throw new Error("Wire this up to your own cart_id tracking store");
}

export async function run() {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const trackedIds = await loadTrackedCartIds();

  const carts = [];
  for (const cartId of trackedIds) {
    const data = await fetchCart(cartId);
    if (data === null) continue;
    carts.push({
      cart_id: data.id,
      customer_id: data.customer_id,
      updated_time: data.updated_time ?? nowEpoch,
      line_item_skus: lineItemSkus(data),
    });
  }

  const duplicates = classifyCartDuplicates(carts, nowEpoch, CART_VALIDITY_DAYS);

  const activeIds = await activeCustomerIds(Object.keys(duplicates).map(Number));

  let deleted = 0;
  let flagged = 0;
  for (const [customerId, info] of Object.entries(duplicates)) {
    if (!activeIds.has(Number(customerId))) {
      console.warn(`customer_id=${customerId} no longer active, skipping cleanup entirely`);
      continue;
    }

    for (const orphanId of info.orphans_needs_merge) {
      console.warn(
        `customer_id=${customerId} orphan cart_id=${orphanId} needs manual merge into canonical cart_id=${info.canonical}`
      );
      flagged += 1;
    }

    for (const orphanId of info.orphans_deletable) {
      console.log(
        `customer_id=${customerId} orphan cart_id=${orphanId} is a subset of canonical cart_id=${info.canonical} ` +
        `(${DRY_RUN ? "dry run" : "deleting"})`
      );
      if (!DRY_RUN) await bcDelete(`/carts/${orphanId}`);
      deleted += 1;
    }
  }

  console.log(
    `Done. ${deleted} orphan cart(s) ${DRY_RUN ? "to delete" : "deleted"}, ${flagged} orphan(s) flagged for manual merge.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
