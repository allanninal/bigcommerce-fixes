/**
 * Find and safely merge duplicate BigCommerce customers that share one email.
 *
 * BigCommerce enforces email uniqueness only within the customer record created
 * through a single path at a time: guest checkout (which stores the email on
 * order.billing_address and leaves order.customer_id at 0, meaning no customer
 * record exists), storefront self-registration, admin-panel manual creation, and
 * V3 Customers API upserts. Nothing reconciles a guest order to a later account,
 * and nothing merges two customer objects that share an email.
 *
 * This pulls every customer, pulls every orphaned guest order, groups customers
 * by normalized email with a pure function, picks the earliest account per
 * cluster as the survivor, reassigns every matching order (including guest
 * orders) onto the survivor with PUT /v2/orders/{id}, confirms the loser has
 * zero orders left, then deletes the duplicate. Guarded by DRY_RUN. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/duplicate-customers-for-one-email/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "dummy_store_hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

export function planCustomerMerge(customers, orders) {
  const groups = new Map();
  for (const customer of customers) {
    const key = normalizeEmail(customer.email);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(customer);
  }

  const plans = [];
  for (const [email, group] of groups) {
    if (group.length < 2) continue;
    const survivor = group.reduce((best, c) =>
      c.date_created < best.date_created ||
      (c.date_created === best.date_created && c.id < best.id) ? c : best
    );
    const losingIds = new Set(group.filter((c) => c.id !== survivor.id).map((c) => c.id));

    const reassignOrderIds = [];
    for (const order of orders) {
      if (normalizeEmail(order.billing_email) !== email) continue;
      if (order.customer_id === 0 || losingIds.has(order.customer_id)) {
        reassignOrderIds.push(order.id);
      }
    }

    plans.push({
      survivorId: survivor.id,
      reassignOrderIds: reassignOrderIds.sort((a, b) => a - b),
      deleteCustomerIds: [...losingIds].sort((a, b) => a - b),
    });
  }

  plans.sort((a, b) => a.survivorId - b.survivorId);
  return plans;
}

async function bc(method, path, body) {
  const res = await fetch(BASE + path.replace(/^\//, ""), {
    method,
    headers: { "X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

async function* allCustomers() {
  let page = 1;
  while (true) {
    const res = await fetch(`${BASE}v3/customers?limit=250&page=${page}`, {
      headers: { "X-Auth-Token": TOKEN, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
    const body = await res.json();
    for (const row of body.data) {
      yield { id: row.id, email: row.email, date_created: row.date_created };
    }
    if (page >= body.meta.pagination.total_pages) return;
    page += 1;
  }
}

async function* guestOrders() {
  let page = 1;
  while (true) {
    const batch = await bc("GET", `/v2/orders?customer_id=0&limit=250&page=${page}`);
    if (!batch || !batch.length) return;
    for (const order of batch) {
      yield {
        id: order.id,
        customer_id: order.customer_id ?? 0,
        billing_email: order.billing_address?.email || "",
      };
    }
    if (batch.length < 250) return;
    page += 1;
  }
}

async function reassignOrder(orderId, survivorId) {
  return bc("PUT", `/v2/orders/${orderId}`, { customer_id: survivorId });
}

async function loserOrdersRemaining(loserId) {
  const remaining = await bc("GET", `/v2/orders?customer_id=${loserId}&limit=1`);
  return (remaining || []).length;
}

async function deleteCustomer(customerId) {
  return bc("DELETE", `/v3/customers?id:in=${customerId}`);
}

export async function run() {
  const customers = [];
  for await (const customer of allCustomers()) customers.push(customer);

  const orders = [];
  for await (const order of guestOrders()) orders.push(order);

  const plans = planCustomerMerge(customers, orders);

  let merged = 0;
  for (const plan of plans) {
    console.warn(
      `Cluster survivor=${plan.survivorId} reassign=${JSON.stringify(plan.reassignOrderIds)} delete=${JSON.stringify(plan.deleteCustomerIds)}. ${DRY_RUN ? "would merge" : "merging"}`
    );
    if (DRY_RUN) {
      merged++;
      continue;
    }

    for (const orderId of plan.reassignOrderIds) {
      await reassignOrder(orderId, plan.survivorId);
    }

    for (const loserId of plan.deleteCustomerIds) {
      if ((await loserOrdersRemaining(loserId)) > 0) {
        console.error(`Skipping delete of ${loserId}, orders still remain.`);
        continue;
      }
      await deleteCustomer(loserId);
    }

    merged++;
  }

  console.log(`Done. ${merged} cluster(s) ${DRY_RUN ? "to merge" : "merged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
