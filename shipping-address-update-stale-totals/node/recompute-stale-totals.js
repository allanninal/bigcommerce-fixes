/**
 * Detect and repair BigCommerce orders whose shipping address changed but
 * whose tax and shipping totals never recomputed.
 *
 * BigCommerce's V2 Orders API treats the order shipping address as a plain
 * address record, not a pricing input. PUT /v2/orders/{id}/shippingaddresses/{id}
 * only writes street/city/zip/country fields and never re-runs the shipping-rate
 * lookup or the tax engine, because both only happen inside cart and checkout
 * consignment flows on /v3/checkouts, not on the order object itself. Order-level
 * fields like base_shipping_cost, shipping_cost_ex_tax/inc_tax, and total_tax are
 * static snapshots taken at order creation, so editing the address afterward
 * silently desyncs those money fields from the real destination.
 *
 * This job lists candidate orders, diffs the live shipping address against a
 * saved address hash, and for orders that are still in an editable status
 * (Incomplete, Pending, Awaiting Payment, Awaiting Shipment, Awaiting
 * Fulfillment) with stale totals, builds a fresh checkout consignment quote and
 * a fresh tax estimate, then writes shipping_cost_ex_tax, shipping_cost_inc_tax,
 * and total_tax back together. Orders in a locked status are always skipped.
 * Safe to run again and again. Defaults to DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/shipping-address-update-stale-totals/
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const V2_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const V3_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EDITABLE_STATUSES = new Set([0, 1, 7, 9, 11]);
const LOCKED_STATUSES = new Set([2, 3, 4, 5, 6, 10, 13, 14]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/** Stable hash of the fields that actually affect shipping and tax. */
export function hashAddress(address) {
  const a = address || {};
  const parts = [a.street_1, a.city, a.state, a.zip, a.country_iso2].map((p) =>
    (p || "").trim().toLowerCase()
  );
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Pure decision logic (no I/O). Given the last-known order (with total_tax,
 * shipping_cost_ex_tax, shipping_cost_inc_tax, base_shipping_cost, status_id,
 * date_modified) and the current live shipping address plus the previously
 * recorded address hash, decide whether the order's totals are stale and
 * whether a repair write is safe to apply.
 *
 * Returns: {
 *   address_changed: boolean,
 *   stale_totals: boolean,
 *   action: "flag_only" | "recompute" | "skip_locked_status",
 *   reason: string,
 * }
 *
 * Logic:
 *   1. newHash = hashAddress(liveShippingAddress) over street_1/city/state/zip/country_iso2
 *   2. addressChanged = (newHash !== cachedAddressHash)
 *   3. lockedStatuses = {2,3,4,5,6,10,13,14} // Shipped/Refunded/Cancelled/etc.
 *   4. if order.status_id is locked: action = "skip_locked_status"
 *   5. else if addressChanged and totals unchanged since cached snapshot:
 *        staleTotals = true; action = "recompute"
 *   6. else: staleTotals = false; action = "flag_only" (no-op)
 *
 * This function never reads DRY_RUN. It decides what should happen to an
 * order; the caller (run(), below) is the only place that decides whether a
 * "recompute" action is actually written or only logged, based on DRY_RUN.
 *
 * order._totalsUnchangedSinceSnapshot defaults to true: callers that already
 * know the totals moved should pass false explicitly.
 */
export function decideRecompute(order, liveShippingAddress, cachedAddressHash) {
  const newHash = hashAddress(liveShippingAddress);
  const addressChanged = newHash !== cachedAddressHash;
  const statusId = order.status_id;

  if (LOCKED_STATUSES.has(statusId)) {
    return {
      address_changed: addressChanged,
      stale_totals: false,
      action: "skip_locked_status",
      reason: `status_id ${statusId} is locked; totals are never rewritten.`,
    };
  }

  const totalsUnchanged = order._totalsUnchangedSinceSnapshot !== false;

  if (addressChanged && totalsUnchanged) {
    return {
      address_changed: true,
      stale_totals: true,
      action: "recompute",
      reason: "Address changed but total_tax/shipping_cost did not move.",
    };
  }

  return {
    address_changed: addressChanged,
    stale_totals: false,
    action: "flag_only",
    reason: "No stale totals detected.",
  };
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
  const res = await fetch(`${base}${path}`, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcPost(base, path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* candidateOrders() {
  let page = 1;
  const statuses = [...EDITABLE_STATUSES, ...LOCKED_STATUSES].sort((a, b) => a - b).join(",");
  while (true) {
    const orders = await bcGet(V2_BASE, "/orders", {
      min_date_modified: `-${LOOKBACK_DAYS} days`,
      status_id: statuses,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function liveShippingAddress(orderId) {
  const addresses = await bcGet(V2_BASE, `/orders/${orderId}/shippingaddresses`);
  return addresses[0] || null;
}

async function orderLineItems(orderId) {
  return bcGet(V2_BASE, `/orders/${orderId}/products`);
}

async function getShippingQuote(checkoutId, newAddress, lineItems) {
  const body = { line_items: lineItems, shipping_address: newAddress };
  const result = await bcPost(
    V3_BASE,
    `/checkouts/${checkoutId}/consignments?include=consignments.availableShippingOptions`,
    [body]
  );
  const consignments = result?.data?.consignments || [];
  const options = consignments[0]?.available_shipping_options || [];
  return options[0] || null;
}

async function getTaxEstimate(newAddress, lineItems) {
  const body = { address: newAddress, line_items: lineItems };
  return bcPost(V3_BASE, "/tax-provider/estimate", body);
}

async function writeRecomputedTotals(orderId, shippingExTax, shippingIncTax, totalTax, subtotalTax, handlingCost) {
  const body = {
    shipping_cost_ex_tax: shippingExTax.toFixed(2),
    shipping_cost_inc_tax: shippingIncTax.toFixed(2),
    total_tax: totalTax.toFixed(2),
    subtotal_tax: subtotalTax.toFixed(2),
    handling_cost: handlingCost.toFixed(2),
  };
  return bcPut(V2_BASE, `/orders/${orderId}`, body);
}

/** Placeholder for your own persistence layer (database, key/value store). */
async function loadCachedAddressHash(_orderId) {
  return null;
}

/** Placeholder for your own persistence layer. */
async function saveAddressHash(_orderId, _addressHash) {
  return null;
}

export async function run() {
  let recomputed = 0;
  let flagged = 0;
  let skipped = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const statusId = order.status_id;
    const address = await liveShippingAddress(orderId);
    const cachedHash = await loadCachedAddressHash(orderId);

    const decision = decideRecompute(order, address, cachedHash);

    if (decision.action === "skip_locked_status") {
      skipped += 1;
      continue;
    }

    if (decision.action === "flag_only") {
      if (decision.stale_totals) {
        console.warn(`Order ${orderId} flagged for review. status_id=${statusId} reason=${decision.reason}`);
        flagged += 1;
      }
      await saveAddressHash(orderId, hashAddress(address));
      continue;
    }

    const lineItems = await orderLineItems(orderId);
    const checkoutId = order.checkout_id || order.cart_id;
    const shippingOption = checkoutId ? await getShippingQuote(checkoutId, address, lineItems) : null;
    const taxEstimate = await getTaxEstimate(address, lineItems);

    const shippingExTax = Number(shippingOption?.cost || 0);
    const taxTotal = Number(taxEstimate?.total_tax || 0);
    const shippingIncTax = shippingExTax + taxTotal;
    const subtotalTax = Number(taxEstimate?.subtotal_tax ?? taxTotal);
    const handlingCost = Number(order.handling_cost_ex_tax || 0);

    console.log(
      `order_id=${orderId} status_id=${statusId} new_shipping_ex_tax=${shippingExTax.toFixed(2)} ` +
      `new_shipping_inc_tax=${shippingIncTax.toFixed(2)} new_total_tax=${taxTotal.toFixed(2)} ` +
      `(${DRY_RUN ? "dry run" : "writing"})`
    );

    if (!DRY_RUN) {
      await writeRecomputedTotals(orderId, shippingExTax, shippingIncTax, taxTotal, subtotalTax, handlingCost);
    }
    await saveAddressHash(orderId, hashAddress(address));
    recomputed += 1;
  }

  console.log(
    `Done. ${recomputed} order(s) ${DRY_RUN ? "to recompute" : "recomputed"}, ${flagged} flagged for review, ${skipped} skipped (locked status).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
