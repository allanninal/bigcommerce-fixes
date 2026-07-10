/**
 * Link BigCommerce guest orders to the customer account that matches the billing email.
 *
 * BigCommerce checkout lets shoppers buy without registering. Every guest
 * order is stored with customer_id = 0 permanently, and BigCommerce never
 * retroactively links it, even if that same email later registers or already
 * has an account. Matching is name and email based only in the merchant's
 * head, since the storefront and Order Management UI have no automatic
 * "same email, different order" reconciliation. At scale this means loyalty
 * history, reorder, and lifetime value reporting silently miss every guest
 * purchase whose email happens to match a real account.
 *
 * This job lists guest orders (customer_id = 0) within a lookback window,
 * reads each order's billing email, resolves that email against the customer
 * table, and reassigns customer_id only when there is exactly one confident
 * match. Orders with zero matches (no account exists) or more than one match
 * (ambiguous, e.g. after a merge) are left untouched for manual review in the
 * admin's "Existing customer" order-edit flow. Run on a schedule. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/guest-orders-not-linked-to-accounts/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const GUEST_CUSTOMER_ID = 0;
// Skip Incomplete (0), Cancelled (5), Declined (6). Everything else is a real order.
const EXCLUDED_STATUSES = new Set([0, 5, 6]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no DB calls.
 *
 * order: {id, customer_id, billing_email, status_id}
 * customerMatches: [{id, email}, ...] pre-fetched matches for the order's email
 *
 * Returns {action: "link" | "flag" | "skip", targetCustomerId: number | null, reason: string}
 */
export function decideOrderLink(order, customerMatches) {
  if (order.customer_id !== GUEST_CUSTOMER_ID) {
    return { action: "skip", targetCustomerId: null, reason: "already linked to a customer" };
  }

  if (EXCLUDED_STATUSES.has(order.status_id)) {
    return { action: "skip", targetCustomerId: null, reason: "incomplete, cancelled, or declined" };
  }

  if (customerMatches.length === 0) {
    return { action: "flag", targetCustomerId: null, reason: "no account matches this email" };
  }

  if (customerMatches.length > 1) {
    return { action: "flag", targetCustomerId: null, reason: "multiple accounts share this email" };
  }

  const match = customerMatches[0];
  const orderEmail = (order.billing_email || "").trim().toLowerCase();
  const matchEmail = (match.email || "").trim().toLowerCase();
  if (matchEmail !== orderEmail) {
    return { action: "flag", targetCustomerId: null, reason: "email does not match exactly" };
  }

  return { action: "link", targetCustomerId: match.id, reason: "exactly one confident email match" };
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

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE_V2}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* guestOrders() {
  let page = 1;
  while (true) {
    const orders = await bcGet(API_BASE_V2, "/orders", {
      customer_id: GUEST_CUSTOMER_ID,
      min_date_created: `-${LOOKBACK_DAYS} days`,
      page,
      limit: 250,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderBillingEmail(orderId) {
  const order = await bcGet(API_BASE_V2, `/orders/${orderId}`);
  return (order && order.billing_address && order.billing_address.email) || "";
}

async function findCustomerMatches(email) {
  if (!email) return [];
  const data = await bcGet(API_BASE_V3, "/customers", { "email:in": email });
  return ((data && data.data) || []).map((c) => ({ id: c.id, email: c.email || "" }));
}

async function linkOrder(orderId, customerId) {
  return bcPut(`/orders/${orderId}`, { customer_id: customerId });
}

export async function run() {
  let linked = 0;
  let flagged = 0;

  for await (const order of guestOrders()) {
    const orderId = order.id;
    const billingEmail = await orderBillingEmail(orderId);
    const matches = await findCustomerMatches(billingEmail);

    const decision = decideOrderLink(
      {
        id: orderId,
        customer_id: order.customer_id ?? GUEST_CUSTOMER_ID,
        billing_email: billingEmail,
        status_id: order.status_id,
      },
      matches,
    );

    if (decision.action === "skip") continue;

    if (decision.action === "flag") {
      console.warn(
        `order_id=${orderId} billing_email=${billingEmail} matches=${matches.length} flagged: ${decision.reason}`,
      );
      flagged += 1;
      continue;
    }

    console.log(
      `order_id=${orderId} old_customer_id=0 new_customer_id=${decision.targetCustomerId} matched_email=${billingEmail} ` +
      `${DRY_RUN ? "would link" : "linking"}`,
    );
    if (!DRY_RUN) await linkOrder(orderId, decision.targetCustomerId);
    linked += 1;
  }

  console.log(
    `Done. ${linked} order(s) ${DRY_RUN ? "to link" : "linked"}, ${flagged} order(s) flagged for manual review.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
