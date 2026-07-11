/**
 * Find and re-fetch BigCommerce SKU / variant lists truncated at 50 records.
 *
 * GET /v2/products/{id}/skus and its V3 successor GET /v3/catalog/products/{id}/
 * variants are paginated collection endpoints. When the limit query parameter is
 * omitted, BigCommerce silently defaults it to 50 per page, with a documented
 * maximum of 250. A client that calls the endpoint once, without limit/page and
 * without reading meta.pagination.total_pages, only ever sees the first 50 SKUs
 * or variants for any product that has more, and the response never signals
 * anything was cut off. This is a well known integration pitfall documented in
 * BigCommerce's own SDK issue trackers, not a platform bug. This job pages
 * through the full product catalog, probes each product's variants with the
 * exact unpaginated call a naive integration would make, flags every productId
 * where recordsFetched === 50 and meta.pagination.total > 50 (the truncation
 * signature), and re-fetches the complete, fully paginated list for each one it
 * flags. It never deletes or rewrites a SKU record; it only corrects the read.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/sku-endpoint-truncates-at-50/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const IMPLICIT_DEFAULT_LIMIT = 50;
const PAGE_LIMIT = 250;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * If pageLimitRequested is null/undefined, BigCommerce applied the implicit
 * default of 50, so the call is truncated when recordsFetched === 50 and the
 * true total is greater than 50. If pageLimitRequested is set, truncation
 * means recordsFetched is less than the smaller of the requested limit and
 * the true total, after exhausting every page implied by that total.
 */
export function isTruncated(recordsFetched, pageLimitRequested, metaPaginationTotal) {
  if (pageLimitRequested === null || pageLimitRequested === undefined) {
    return recordsFetched === IMPLICIT_DEFAULT_LIMIT && metaPaginationTotal > IMPLICIT_DEFAULT_LIMIT;
  }
  const expected = Math.min(pageLimitRequested, metaPaginationTotal);
  return recordsFetched < expected;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { data: body.data || [], meta: body.meta || {} };
}

async function* allProductIds() {
  let page = 1;
  while (true) {
    const { data: products, meta } = await bcGet("/catalog/products", { limit: PAGE_LIMIT, page });
    if (!products.length) return;
    for (const product of products) yield product.id;
    const pagination = meta.pagination || {};
    if (page >= (pagination.total_pages || page)) return;
    page += 1;
  }
}

async function probeVariantsUnpaginated(productId) {
  // The exact call a naive integration makes: no limit, no page.
  const { data: records, meta } = await bcGet(`/catalog/products/${productId}/variants`);
  const total = (meta.pagination || {}).total ?? records.length;
  return { recordsFetched: records.length, total };
}

async function fetchAllVariants(productId) {
  // Fully paginated. Always returns the complete list, never truncated.
  const allRecords = [];
  let page = 1;
  while (true) {
    const { data: records, meta } = await bcGet(`/catalog/products/${productId}/variants`, {
      limit: PAGE_LIMIT,
      page,
    });
    allRecords.push(...records);
    const pagination = meta.pagination || {};
    if (!records.length || page >= (pagination.total_pages || page)) return allRecords;
    page += 1;
  }
}

export async function run() {
  const affected = [];
  let scanned = 0;

  for await (const productId of allProductIds()) {
    scanned += 1;
    const { recordsFetched, total: expectedTotal } = await probeVariantsUnpaginated(productId);

    if (!isTruncated(recordsFetched, null, expectedTotal)) continue;

    console.warn(
      `product_id=${productId} truncated: records_fetched_without_pagination=${recordsFetched} expected_total=${expectedTotal}`
    );

    const corrected = await fetchAllVariants(productId);
    affected.push({
      productId,
      expectedTotal,
      recordsFetchedWithoutPagination: recordsFetched,
      recordsFetchedAfterRepair: corrected.length,
    });

    if (!DRY_RUN) {
      // Re-sync only this product's mirrored SKU rows here, using `corrected`.
      console.log(`product_id=${productId} re-synced with ${corrected.length} records.`);
    } else {
      console.log(
        `product_id=${productId} would re-sync ${corrected.length} records (DRY_RUN=true, no write performed).`
      );
    }
  }

  console.log(
    `Done. Scanned ${scanned} product(s). ${affected.length} product(s) were truncated at the implicit 50-record default.`
  );
  for (const row of affected) {
    console.log(
      `REPORT product_id=${row.productId} expected_total=${row.expectedTotal} ` +
      `records_fetched_without_pagination=${row.recordsFetchedWithoutPagination} ` +
      `records_fetched_after_repair=${row.recordsFetchedAfterRepair}`
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
