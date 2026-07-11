/**
 * Detect a silent no-op when POST /v3/customers/addresses matches a duplicate.
 *
 * BigCommerce's V3 Customer Addresses endpoint treats first_name, last_name,
 * company, phone, address_type, address1, address2, city, country_code,
 * state_or_province, and postal_code as a uniqueness key per customer. When a
 * POST matches an existing address on all of these fields, BigCommerce makes
 * no change to the existing record and returns a 200 or 207 success, but the
 * address is omitted from the response body's data, so no new address id is
 * ever returned. An integration that assumes 200 means "created, id returned"
 * will misreport the operation and drift out of sync with the store's real
 * address list. This script snapshots a customer's addresses before the
 * write, posts the new address, snapshots again, and classifies the result
 * with a pure function. A confirmed silent no-op is flagged and reported
 * with the matched existing address id, never retried, since there is no bad
 * state to repair.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/duplicate-address-create-silent-noop/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const UNIQUENESS_FIELDS = [
  "first_name", "last_name", "company", "phone", "address_type",
  "address1", "address2", "city", "country_code", "state_or_province", "postal_code",
];

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function uniquenessKey(fields) {
  return UNIQUENESS_FIELDS.map((f) => String(fields[f] || "").trim().toLowerCase()).join("|");
}

export function findMatchedAddressId(existingAddresses, attemptedFields) {
  const target = uniquenessKey(attemptedFields);
  for (const addr of existingAddresses) {
    if (uniquenessKey(addr) === target) return addr.id;
  }
  return null;
}

/**
 * Pure decision. No network, no side effects.
 *
 * if postResponse.status >= 400: "error".
 * Else if the response has no address id in data, and the post-write
 * snapshot's total and id set are unchanged from the pre-write snapshot,
 * "silent_noop". Otherwise a new id appeared, or data has an id: "created".
 */
export function classifyAddressCreateResult(preSnapshot, postResponse, postSnapshot) {
  const status = postResponse.status;
  if (status === undefined || status === null || status >= 400) return "error";

  const data = postResponse.data;
  const dataHasId =
    (Array.isArray(data) && data.some((item) => item && typeof item === "object" && item.id != null)) ||
    (data && typeof data === "object" && !Array.isArray(data) && data.id != null);

  const preIds = preSnapshot.ids || new Set();
  const postIds = postSnapshot.ids || new Set();
  const newIds = [...postIds].filter((id) => !preIds.has(id));

  const totalUnchanged = postSnapshot.total === preSnapshot.total;
  const idsUnchanged = [...postIds].every((id) => preIds.has(id)) && newIds.length === 0;

  if (!dataHasId && totalUnchanged && idsUnchanged) return "silent_noop";

  return "created";
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : { data: [], meta: { pagination: { total: 0 } } };
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}];
}

async function snapshotAddresses(customerId) {
  const ids = new Set();
  const records = [];
  let page = 1;
  let total = 0;
  while (true) {
    const body = await bcGet("/customers/addresses", {
      "customer_id:in": customerId,
      page,
      limit: 250,
    });
    const data = body.data || [];
    for (const addr of data) {
      ids.add(addr.id);
      records.push(addr);
    }
    const pagination = (body.meta || {}).pagination || {};
    total = pagination.total ?? ids.size;
    const nextLink = (pagination.links || {}).next;
    if (!data.length || !nextLink) break;
    page += 1;
  }
  return { ids, total, records };
}

async function createCustomerAddress(addressFields) {
  return bcPost("/customers/addresses", [addressFields]);
}

export async function run(customerId, addressFields) {
  const preSnapshot = await snapshotAddresses(customerId);

  if (DRY_RUN) {
    console.log(
      `DRY_RUN: would POST address for customer_id=${customerId}. Skipping write, ` +
      `pre_snapshot_total=${preSnapshot.total}`
    );
    return "dry_run";
  }

  const [status, body] = await createCustomerAddress(addressFields);
  const postResponse = { status, data: body.data };

  const postSnapshot = await snapshotAddresses(customerId);
  const decision = classifyAddressCreateResult(preSnapshot, postResponse, postSnapshot);

  if (decision === "error") {
    console.error(`Address create failed. customer_id=${customerId} status=${status} body=${JSON.stringify(body)}`);
    return decision;
  }

  if (decision === "silent_noop") {
    const matchedId = findMatchedAddressId(preSnapshot.records, addressFields);
    console.warn(
      "address_create_silent_noop: exact duplicate already existed, no new " +
      `address_id created. customer_id=${customerId} matched_existing_address_id=${matchedId} ` +
      `attempted_fields=${JSON.stringify(addressFields)}`
    );
    return decision;
  }

  console.log(`Address created for customer_id=${customerId}. total now ${postSnapshot.total}`);
  return decision;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(123, {
    first_name: "Jamie",
    last_name: "Rivera",
    address1: "123 Main St",
    city: "Austin",
    country_code: "US",
    state_or_province: "Texas",
    postal_code: "78701",
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
