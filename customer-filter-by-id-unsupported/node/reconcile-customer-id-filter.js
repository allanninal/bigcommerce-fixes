/**
 * Reconcile BigCommerce customer lookups that were rejected by the v2 id filter.
 *
 * BigCommerce's v2 Customers resource (GET /v2/customers) only accepts a fixed,
 * documented set of filter query params, email, name, company, date_created, and
 * so on. The id field was never implemented as a filterable field on that legacy
 * list endpoint, unlike the v3 Customers API, which supports the id:in=1,2,3
 * filter syntax natively. Scripts and SDKs that assume v3-style filter
 * conventions work uniformly across versions pass ?id=123 to v2 and get a 400,
 * "The field 'id' is not supported by this resource.", because v2's query-string
 * filter whitelist simply omits id. The only supported way to fetch a single
 * customer on v2 is the direct resource path GET /v2/customers/{id}.
 *
 * This is a client-side query-shape bug, not corrupt store data, so there is
 * nothing on the BigCommerce side to write or repair. This job attempts the v2
 * id filter, and on the specific 400 it reconciles a single id through the
 * direct resource path, or signals a migration to the v3 batched id:in filter
 * for multiple ids. Safe to run again and again, read-only by default.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/customer-filter-by-id-unsupported/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_ROOT = `https://api.bigcommerce.com/stores/${STORE_HASH}`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FIELD_NOT_SUPPORTED = /field '(\w+)' is not supported/i;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * if apiVersion === "v3": always ok_list_filter, id:in is supported there.
 * if apiVersion === "v2" and responseStatus === 400 and errorField === "id":
 *   fallback_direct_resource when a single id was requested, since the
 *   direct resource path only fetches one customer at a time, otherwise
 *   migrate_to_v3 when multiple ids were requested.
 * otherwise: ok_list_filter (the call already succeeded, or failed for an
 * unrelated reason that this reconciler does not handle).
 */
export function resolveCustomerLookup(filterQuery, apiVersion, responseStatus, errorField) {
  if (apiVersion === "v3") return "ok_list_filter";

  if (apiVersion === "v2" && responseStatus === 400 && errorField === "id") {
    const requestedIds = filterQuery.id;
    const idCount = requestedIds ? String(requestedIds).split(",").length : 0;
    if (idCount <= 1) return "fallback_direct_resource";
    return "migrate_to_v3";
  }

  return "ok_list_filter";
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, body };
}

async function tryV2IdFilter(ids) {
  const query = { id: ids.join(",") };
  const { status, body } = await bcGet("/v2/customers", query);
  let errorField = null;
  if (status === 400) {
    const match = FIELD_NOT_SUPPORTED.exec(body.error || "");
    if (match) errorField = match[1];
  }
  return { query, status, errorField };
}

async function fetchCustomerDirect(customerId) {
  return bcGet(`/v2/customers/${customerId}`);
}

async function fetchCustomersV3(ids) {
  return bcGet("/v3/customers", { "id:in": ids.join(",") });
}

export async function run(idBatches = [[123]]) {
  let reconciled = 0;
  let migrated = 0;

  for (const ids of idBatches) {
    const { query, status, errorField } = await tryV2IdFilter(ids);
    const decision = resolveCustomerLookup(query, "v2", status, errorField);

    if (decision === "ok_list_filter") {
      console.log(`ids=${ids} v2 list filter succeeded, no reconciliation needed`);
      continue;
    }

    if (decision === "fallback_direct_resource") {
      console.log(
        `ids=${ids} v2 id filter rejected (${errorField}), ${DRY_RUN ? "would call" : "calling"} direct resource path GET /v2/customers/${ids[0]}`
      );
      if (!DRY_RUN) {
        const { status: directStatus } = await fetchCustomerDirect(ids[0]);
        console.log(`direct resource path returned status=${directStatus}`);
      }
      reconciled += 1;
      continue;
    }

    if (decision === "migrate_to_v3") {
      console.log(
        `ids=${ids} v2 id filter rejected (${errorField}), ${DRY_RUN ? "would call" : "calling"} v3 batched filter GET /v3/customers?id:in=${ids.join(",")}`
      );
      if (!DRY_RUN) {
        const { status: v3Status } = await fetchCustomersV3(ids);
        console.log(`v3 batched filter returned status=${v3Status}`);
      }
      migrated += 1;
    }
  }

  console.log(
    `Done. ${reconciled} batch(es) ${DRY_RUN ? "to reconcile" : "reconciled"} via direct resource path, ` +
    `${migrated} batch(es) ${DRY_RUN ? "to migrate" : "migrated"} via v3 id:in.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
