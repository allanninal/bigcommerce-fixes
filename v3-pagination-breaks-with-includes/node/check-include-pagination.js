/**
 * Detect BigCommerce v3 catalog/products pagination truncation with include.
 *
 * BigCommerce's v3 catalog/products endpoint documents that when include=options,
 * include=modifiers, or include=variants is requested, the server silently caps the
 * page size at 10 records per page regardless of the limit query param sent, because
 * hydrating those nested sub-resources per product is expensive to join and
 * serialize. meta.pagination.total is still computed correctly, but total_pages is
 * calculated from the same count query used for the plain, un-hydrated list, so it
 * understates how many 10-record pages are actually needed. A client that walks
 * pages until page > meta.pagination.total_pages stops early and silently drops
 * products from the tail of the catalog.
 *
 * This script never writes anything. It pulls a baseline list (no include) and a
 * suspect list (include=options,modifiers), reconciles the product id sets with a
 * pure function, and logs which product ids the include pull would have missed if
 * total_pages had been trusted as the stop condition. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/v3-pagination-breaks-with-includes/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const INCLUDE_PARAM = process.env.INCLUDE_PARAM || "options,modifiers";
const LIMIT = Number(process.env.LIMIT || 250);
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 10);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Flattens includePullPages[].data[].id into a set, computes missingIds as the
 * baseline ids not present in that set, computes the number of 10-record pages
 * actually needed against the include pull's own per_page, and compares that
 * against the include pull's own reported total_pages. paginationTrustworthy is
 * true only when total_pages covers the pages actually needed AND no ids are
 * missing. recommendedStopCondition is "total_pages" when trustworthy, otherwise
 * "empty_data_array", which is what a caller should switch to.
 */
export function reconcilePaginatedProductIds(baselineIds, includePullPages) {
  const includeIds = new Set();
  for (const page of includePullPages) {
    for (const item of page.data) includeIds.add(String(item.id));
  }

  const missingIds = baselineIds.filter((id) => !includeIds.has(id));

  const perPage = includePullPages[0].meta.pagination.per_page;
  const impliedFullPages = perPage ? Math.ceil(baselineIds.length / perPage) : 0;
  const reportedTotalPages = includePullPages[0].meta.pagination.total_pages;

  const paginationTrustworthy =
    reportedTotalPages >= impliedFullPages && missingIds.length === 0;

  return {
    missingIds,
    paginationTrustworthy,
    recommendedStopCondition: paginationTrustworthy ? "total_pages" : "empty_data_array",
  };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function pullBaseline(limit = LIMIT) {
  let page = 1;
  const ids = [];
  let total = null;
  while (true) {
    const resp = await bcGet("/catalog/products", { limit, page });
    const pagination = resp.meta.pagination;
    total = pagination.total;
    ids.push(...resp.data.map((p) => String(p.id)));
    if (page >= pagination.total_pages) break;
    page += 1;
  }
  return { ids, total };
}

async function pullWithInclude(include = INCLUDE_PARAM, limit = LIMIT) {
  let page = 1;
  const pages = [];
  while (true) {
    const resp = await bcGet("/catalog/products", { limit, page, include });
    pages.push(resp);
    if (!resp.data.length) break;
    page += 1;
  }
  return pages;
}

export async function run() {
  const { ids: baselineIds, total: baselineTotal } = await pullBaseline();
  const includePages = await pullWithInclude();

  const result = reconcilePaginatedProductIds(baselineIds, includePages);

  if (!result.missingIds.length) {
    console.log(
      `store=${STORE_HASH} baseline_total=${baselineTotal} pagination is trustworthy, total_pages is safe to use.`
    );
    return;
  }

  console.warn(
    `store=${STORE_HASH} baseline_total=${baselineTotal} total_pages UNDERSTATES the real page count. ` +
    `missing=${result.missingIds.length} sample_ids=${JSON.stringify(result.missingIds.slice(0, SAMPLE_SIZE))} ` +
    `recommended_stop_condition=${result.recommendedStopCondition}`
  );
  if (DRY_RUN) {
    console.log(
      "DRY_RUN=true: report only. Client-side workaround: when include contains options " +
      "or modifiers, ignore meta.pagination.total_pages and loop page += 1 until a " +
      "response returns data: [] (empty array)."
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
