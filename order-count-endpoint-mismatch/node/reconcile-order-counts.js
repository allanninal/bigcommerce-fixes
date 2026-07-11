/**
 * Reconcile a BigCommerce order count mismatch between /v2/orders/count and /v2/orders.
 *
 * GET /v2/orders/count and GET /v2/orders both accept status_id, min_date_created,
 * max_date_created, and customer_id, and both apply an implicit default scope when
 * status_id is omitted. Incomplete orders (status_id 0, abandoned at payment) are
 * commonly excluded from an unfiltered count's default scope but still appear in an
 * unfiltered pagination scan, so a script calling one endpoint with no filters and
 * the other with a different filter set ends up comparing two different result
 * sets. A secondary cause is timing: count is a point-in-time snapshot, while a
 * multi-page scan can take seconds to minutes on a large store. This job sums
 * per-status counts across all 15 status_id values, fully paginates the order list
 * with the same filters, reconciles the two totals bucket by bucket, and re-checks
 * the count snapshot after pagination to rule out concurrency drift. It only ever
 * reports. It never deletes or modifies an order based on a count mismatch alone.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-count-endpoint-mismatch/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const MIN_DATE_CREATED = process.env.MIN_DATE_CREATED || null;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ALL_STATUS_IDS = Array.from({ length: 15 }, (_, i) => i); // 0 Incomplete .. 14 Partially Refunded
const PAGE_LIMIT = 250;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure comparison. No network, no side effects.
 *
 * countEndpointTotals maps statusId -> count returned by
 * GET /v2/orders/count?status_id={id} for each of the 15 status_id values.
 * paginatedOrderStatusIds is the flat list of status_id values collected by
 * fully paginating GET /v2/orders with the same filters. Returns a plain report
 * with the two grand totals, a per-status delta map, the list of status_id
 * values where the two disagree, and whether every bucket balances.
 */
export function reconcileOrderCounts(countEndpointTotals, paginatedOrderStatusIds) {
  const paginatedCounts = new Map();
  for (const statusId of paginatedOrderStatusIds) {
    paginatedCounts.set(statusId, (paginatedCounts.get(statusId) || 0) + 1);
  }

  const allStatusIds = new Set([
    ...Object.keys(countEndpointTotals).map(Number),
    ...paginatedCounts.keys(),
  ]);

  const perStatusDeltas = {};
  for (const statusId of allStatusIds) {
    const expected = countEndpointTotals[statusId] || 0;
    const actual = paginatedCounts.get(statusId) || 0;
    perStatusDeltas[statusId] = expected - actual;
  }

  const mismatchedStatusIds = Object.keys(perStatusDeltas)
    .map(Number)
    .filter((sid) => perStatusDeltas[sid] !== 0)
    .sort((a, b) => a - b);

  return {
    totalCountEndpoint: Object.values(countEndpointTotals).reduce((a, b) => a + b, 0),
    totalPaginated: paginatedOrderStatusIds.length,
    perStatusDeltas,
    mismatchedStatusIds,
    isConsistent: mismatchedStatusIds.length === 0,
  };
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

async function countByStatus() {
  const totals = {};
  for (const statusId of ALL_STATUS_IDS) {
    const params = { status_id: statusId };
    if (MIN_DATE_CREATED) params.min_date_created = MIN_DATE_CREATED;
    const body = await bcGet("/orders/count", params);
    totals[statusId] = body.count || 0;
  }
  return totals;
}

async function paginateAllOrderStatusIds() {
  const statusIds = [];
  let page = 1;
  while (true) {
    const params = { page, limit: PAGE_LIMIT, sort: "id:asc" };
    if (MIN_DATE_CREATED) params.min_date_created = MIN_DATE_CREATED;
    const orders = await bcGet("/orders", params);
    if (!orders.length) return statusIds;
    for (const order of orders) statusIds.push(order.status_id);
    if (orders.length < PAGE_LIMIT) return statusIds;
    page += 1;
  }
}

function logReport(label, report) {
  console.log(`[${label}] unfiltered_count=${report.totalCountEndpoint} paginated_total=${report.totalPaginated} is_consistent=${report.isConsistent}`);
  if (!report.isConsistent) {
    for (const statusId of report.mismatchedStatusIds) {
      console.warn(`[${label}] status_id=${statusId} delta=${report.perStatusDeltas[statusId]}`);
    }
  }
}

export async function run() {
  console.log(`Fetching per-status counts before pagination (DRY_RUN=${DRY_RUN}, report only, no writes).`);
  const countsBefore = await countByStatus();

  const paginatedStatusIds = await paginateAllOrderStatusIds();

  console.log("Fetching per-status counts again after pagination to check for concurrency drift.");
  const countsAfter = await countByStatus();

  const reportBefore = reconcileOrderCounts(countsBefore, paginatedStatusIds);
  const reportAfter = reconcileOrderCounts(countsAfter, paginatedStatusIds);

  logReport("pre-scan snapshot", reportBefore);
  logReport("post-scan snapshot", reportAfter);

  if (reportBefore.isConsistent && reportAfter.isConsistent) {
    console.log("Consistent. Counts and pagination agree across all status_id buckets.");
    return;
  }

  if (!reportBefore.isConsistent && reportAfter.isConsistent) {
    console.log("Mismatch resolved by the post-scan snapshot. Likely concurrency drift during the scan window.");
    return;
  }

  console.warn(
    `Persistent mismatch after re-checking the count snapshot. mismatchedStatusIds=${JSON.stringify(reportAfter.mismatchedStatusIds)}. ` +
    `This is a report for a human, escalate to BigCommerce support with store_hash=${STORE_HASH}, ` +
    `min_date_created=${MIN_DATE_CREATED}, and the mismatched status_id list. No orders were modified.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
