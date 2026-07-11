/**
 * Find and repair BigCommerce carts still quoting a stale customer-group price.
 *
 * BigCommerce resolves customer-group pricing by joining the customer's
 * customer_group_id (a V2-only field, customer groups are "not yet available
 * on the V3 Customers API") to a price list through /v3/pricelists/assignments,
 * then reading /v3/pricelists/{id}/records for the variant. That resolution
 * happens once per cart or session and gets cached: an existing cart keeps
 * the price snapshot captured under the old group, storefront and CDN edge
 * caching can serve pre-rendered pricing for several minutes, and
 * BigCommerce support documentation itself warns pricing changes can take up
 * to about 10 minutes to propagate. So when an admin moves a customer
 * between groups, the customer record updates immediately but an
 * already-created cart, an active browser session, or an edge-cached page
 * keeps quoting the old group's price list until a new cart or session
 * forces re-resolution.
 *
 * This job audits a list of customer/cart pairs, reads the customer's
 * current group and the price list it maps to, compares that against each
 * cart line item's recorded price, and for a genuine mismatch forces that
 * one cart to re-resolve, either by resubmitting the line item quantity or
 * deleting the cart. It never rewrites the price list record itself, that
 * would change pricing for every customer in the group, not just fix the
 * one stale cart.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/customer-group-change-stale-price-cache/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_ROOT = `https://api.bigcommerce.com/stores/${STORE_HASH}`;
const CHANNEL_ID = process.env.CHANNEL_ID || "1";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * expected = priceListRecord's sale_price if set, else its price.
 * actual = cartLineItem's sale_price if set, else its list_price.
 * Returns true when the two disagree by more than tolerance, meaning the
 * cart is still quoting a price that does not match what the customer's
 * current group and price list would produce right now.
 */
export function isPriceStale(cartLineItem, priceListRecord, tolerance = 0.01) {
  const expected =
    priceListRecord.sale_price !== null && priceListRecord.sale_price !== undefined
      ? priceListRecord.sale_price
      : priceListRecord.price;
  const actual =
    cartLineItem.sale_price !== null && cartLineItem.sale_price !== undefined
      ? cartLineItem.sale_price
      : cartLineItem.list_price;
  return Math.abs(Number(expected) - Number(actual)) > tolerance;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function bcPut(path, body) {
  const res = await fetch(`${API_ROOT}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function bcDelete(path) {
  const res = await fetch(`${API_ROOT}${path}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
}

async function currentCustomerGroupId(customerId) {
  const customer = await bcGet(`/v2/customers/${customerId}`);
  return customer.customer_group_id;
}

async function priceListIdForGroup(customerGroupId, channelId = CHANNEL_ID) {
  const resp = await bcGet("/v3/pricelists/assignments", {
    customer_group_id: customerGroupId,
    channel_id: channelId,
  });
  const assignments = resp.data || [];
  return assignments.length ? assignments[0].price_list_id : null;
}

async function getCart(cartId) {
  return bcGet(`/v3/carts/${cartId}`);
}

async function priceListRecordForVariant(priceListId, variantId) {
  const resp = await bcGet(`/v3/pricelists/${priceListId}/records`, { variant_id: variantId });
  const records = resp.data || [];
  return records.length ? records[0] : null;
}

async function forceLineItemReresolve(cartId, itemId, quantity) {
  return bcPut(`/v3/carts/${cartId}/items/${itemId}`, { line_item: { quantity } });
}

async function forceCartRefreshByDelete(cartId) {
  await bcDelete(`/v3/carts/${cartId}`);
}

function auditTargets() {
  try {
    return JSON.parse(process.env.AUDIT_TARGETS_JSON || "[]");
  } catch {
    return [];
  }
}

export async function run() {
  let checked = 0;
  let repaired = 0;

  for (const target of auditTargets()) {
    const { customer_id: customerId, cart_id: cartId, old_group_id: oldGroupId } = target;

    const newGroupId = await currentCustomerGroupId(customerId);
    const priceListId = await priceListIdForGroup(newGroupId);
    if (priceListId == null) {
      console.warn(`No price list assignment for customer ${customerId} group ${newGroupId}, skipping.`);
      continue;
    }

    const cart = await getCart(cartId);
    const lineItems = cart?.data?.line_items?.physical_items || [];

    for (const lineItem of lineItems) {
      checked += 1;
      const record = await priceListRecordForVariant(priceListId, lineItem.variant_id);
      if (!record) continue;

      if (!isPriceStale(lineItem, record)) continue;

      const expected = record.sale_price != null ? record.sale_price : record.price;
      const actual = lineItem.sale_price != null ? lineItem.sale_price : lineItem.list_price;

      console.log(
        `cart_id=${cartId} customer_id=${customerId} old_group=${oldGroupId} new_group=${newGroupId} ` +
        `cart_price=${actual} expected_price=${expected} (${DRY_RUN ? "dry run" : "repairing"})`
      );

      if (!DRY_RUN) await forceLineItemReresolve(cartId, lineItem.id, lineItem.quantity);
      repaired += 1;
    }
  }

  console.log(
    `Done. ${checked} line item(s) checked, ${repaired} ${DRY_RUN ? "would be repaired" : "repaired"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
