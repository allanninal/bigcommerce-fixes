/**
 * Consolidate duplicate BigCommerce customer records onto one canonical customer_id.
 *
 * BigCommerce creates a fully independent customer record for guest checkout,
 * storefront registration, and admin-panel entry, and treats each customer_id
 * as its own entity with orders owned through order.customer_id and addresses
 * owned through address.customer_id. There is no merge or alias relationship
 * in the data model, and the REST Management API only exposes CRUD on
 * individual resources, never a bulk reassign-all-child-resources call, so
 * BigCommerce never shipped a merge endpoint. This job clusters customers by
 * normalized email, picks a canonical customer_id per cluster, reassigns every
 * order from the duplicate to the canonical id, recreates any address on the
 * canonical id that does not already exist there, and flags the duplicate
 * customer_id for human confirmation. It never deletes a customer record on
 * its own. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/no-customer-merge-endpoint/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function addressKey(address) {
  return [
    (address.address1 || "").trim().toLowerCase(),
    (address.postal_code || "").trim().toLowerCase(),
    (address.city || "").trim().toLowerCase(),
  ].join("|");
}

/**
 * Pure decision. No network, no side effects.
 *
 * Every order id under duplicate.orders is added to ordersToReassign,
 * regardless of status_id, so refunded and cancelled orders are preserved.
 * Each duplicate address is compared to the canonical customer's addresses
 * by a normalized (address1, postal_code, city) key: a match is skipped,
 * anything else is queued to be recreated. duplicateCustomerIdToDeactivate
 * is always duplicate.id, asserted to never equal canonical.id.
 *
 * @param {{id: number, addresses: Array<object>}} canonical
 * @param {{id: number, orders: Array<{id: number}>, addresses: Array<object>}} duplicate
 * @returns {{
 *   ordersToReassign: number[],
 *   addressesToCreate: object[],
 *   addressesToSkip: number[],
 *   duplicateCustomerIdToDeactivate: number,
 * }}
 */
export function planCustomerMerge(canonical, duplicate) {
  const canonicalKeys = new Set((canonical.addresses || []).map(addressKey));

  const ordersToReassign = (duplicate.orders || []).map((o) => o.id);

  const addressesToCreate = [];
  const addressesToSkip = [];
  for (const address of duplicate.addresses || []) {
    if (canonicalKeys.has(addressKey(address))) {
      addressesToSkip.push(address.id);
    } else {
      addressesToCreate.push(address);
    }
  }

  const duplicateCustomerIdToDeactivate = duplicate.id;
  if (duplicateCustomerIdToDeactivate === canonical.id) {
    throw new Error("duplicate customer_id must never equal canonical customer_id");
  }

  return {
    ordersToReassign,
    addressesToCreate,
    addressesToSkip,
    duplicateCustomerIdToDeactivate,
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
  return text ? JSON.parse(text) : {};
}

async function bcPut(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcPost(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* allCustomers() {
  let page = 1;
  while (true) {
    const resp = await bcGet(API_BASE_V3, "/customers", { limit: 250, page });
    const rows = resp.data || [];
    if (!rows.length) return;
    for (const row of rows) yield row;
    page += 1;
  }
}

function clusterByEmail(customers) {
  const clusters = new Map();
  for (const c of customers) {
    const key = (c.email || "").trim().toLowerCase();
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(c);
  }
  for (const [key, rows] of clusters) {
    if (rows.length <= 1) clusters.delete(key);
  }
  return clusters;
}

async function customerOrders(customerId) {
  const orders = [];
  let page = 1;
  while (true) {
    const rows = await bcGet(API_BASE_V2, "/orders", { customer_id: customerId, limit: 250, page });
    if (!rows.length) return orders;
    orders.push(...rows);
    page += 1;
  }
}

async function customerAddresses(customerId) {
  const resp = await bcGet(API_BASE_V3, "/customers/addresses", { "customer_id:in": customerId });
  return resp.data || [];
}

async function reassignOrder(orderId, canonicalId) {
  return bcPut(API_BASE_V2, `/orders/${orderId}`, { customer_id: canonicalId });
}

async function createAddress(canonicalId, address) {
  const payload = [{
    customer_id: canonicalId,
    first_name: address.first_name || "",
    last_name: address.last_name || "",
    address1: address.address1 || "",
    city: address.city || "",
    state_or_province: address.state_or_province || "",
    postal_code: address.postal_code || "",
    country_code: address.country_code || "",
  }];
  return bcPost(API_BASE_V3, "/customers/addresses", payload);
}

function pickCanonical(cluster) {
  return [...cluster].sort((a, b) => a.id - b.id)[0];
}

export async function run() {
  const customers = [];
  for await (const c of allCustomers()) customers.push(c);
  const clusters = clusterByEmail(customers);

  let merged = 0;
  let flagged = 0;

  for (const [email, members] of clusters) {
    const canonicalRecord = pickCanonical(members);
    const canonicalId = canonicalRecord.id;
    const canonical = { id: canonicalId, addresses: await customerAddresses(canonicalId) };

    for (const member of members) {
      if (member.id === canonicalId) continue;

      const duplicate = {
        id: member.id,
        orders: await customerOrders(member.id),
        addresses: await customerAddresses(member.id),
      };

      const plan = planCustomerMerge(canonical, duplicate);

      console.log(
        `email=${email} canonical_id=${canonicalId} duplicate_id=${plan.duplicateCustomerIdToDeactivate} ` +
        `orders_to_reassign=${JSON.stringify(plan.ordersToReassign)} ` +
        `addresses_to_create=${plan.addressesToCreate.length} addresses_to_skip=${JSON.stringify(plan.addressesToSkip)} ` +
        `(${DRY_RUN ? "dry run" : "applying"})`
      );

      if (!DRY_RUN) {
        for (const orderId of plan.ordersToReassign) await reassignOrder(orderId, canonicalId);
        for (const address of plan.addressesToCreate) await createAddress(canonicalId, address);
      }

      console.warn(`Duplicate customer_id ${plan.duplicateCustomerIdToDeactivate} flagged for human confirmation before deletion.`);
      merged += 1;
      flagged += 1;
    }
  }

  console.log(`Done. ${merged} duplicate(s) ${DRY_RUN ? "to merge" : "merged"}, ${flagged} duplicate(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
