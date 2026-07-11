/**
 * Find BigCommerce price list variant coverage gaps.
 *
 * BigCommerce price lists store overrides as flat per-variant records, each
 * keyed by variant_id and currency, not as product-level rules that cascade
 * to child variants. A CSV import, an admin UI edit, or an API batch upsert
 * can easily cover only some of a product's variants and miss newly added
 * ones. Because the pricing engine looks up a record for the exact variant_id
 * being viewed and falls through to standard catalog pricing when nothing
 * matches, the gap is silent: no admin warning, no validation error, no
 * webhook. This job enumerates every active variant storewide, pulls every
 * record from every price list actually assigned to a customer group, and
 * reports every variant missing from an active price list. It never guesses
 * a price. It only reports, unless a caller supplies an explicit fallback
 * rule and DRY_RUN=false.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/price-list-missing-variant-entry/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * covered = variant_ids that already have a record in some price list.
 * gaps = activeVariantIds not in covered.
 * For every price_list_id referenced by groupToPriceList, emit one row per
 * gap variant with the customer_group_ids that reference that list.
 * Returns an array of objects sorted by variant_id.
 */
export function findVariantPriceGaps(activeVariantIds, priceListRecords, groupToPriceList) {
  const covered = new Set(priceListRecords.map((r) => r.variant_id));
  const gaps = [...activeVariantIds].filter((id) => !covered.has(id));

  const priceListIds = new Set(Object.values(groupToPriceList));
  const results = [];
  for (const priceListId of priceListIds) {
    const affectedGroups = Object.entries(groupToPriceList)
      .filter(([, pl]) => pl === priceListId)
      .map(([g]) => Number(g));
    for (const variantId of gaps) {
      results.push({
        price_list_id: priceListId,
        variant_id: variantId,
        affected_customer_groups: affectedGroups,
      });
    }
  }
  return results.sort((a, b) => a.variant_id - b.variant_id);
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

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcGetAllPages(path, params = {}) {
  let page = 1;
  const items = [];
  while (true) {
    const body = await bcGet(path, { ...params, limit: 250, page });
    items.push(...(body.data || []));
    const pagination = (body.meta || {}).pagination || {};
    if (page >= (pagination.total_pages || 1)) return items;
    page += 1;
  }
}

async function activeVariants() {
  const variants = await bcGetAllPages("/catalog/variants");
  const products = await bcGetAllPages("/catalog/products", {
    include_fields: "is_visible,availability",
  });
  const visibleProductIds = new Set(
    products.filter((p) => p.is_visible).map((p) => p.id)
  );
  return variants.filter((v) => visibleProductIds.has(v.product_id));
}

async function groupToPriceList(customerGroupIds) {
  const mapping = {};
  for (const groupId of customerGroupIds) {
    const assignments = await bcGetAllPages("/pricelists/assignments", {
      customer_group_id: groupId,
    });
    for (const a of assignments) {
      if (a.price_list_id) mapping[groupId] = a.price_list_id;
    }
  }
  return mapping;
}

async function priceListRecords(priceListId) {
  return bcGetAllPages(`/pricelists/${priceListId}/records`);
}

function enrichGaps(gaps, variantsById) {
  return gaps.map((gap) => {
    const variant = variantsById[gap.variant_id] || {};
    return {
      ...gap,
      product_id: variant.product_id,
      sku: variant.sku,
    };
  });
}

async function applyFallback(priceListId, recordsToWrite) {
  const batchSize = 1000;
  for (let i = 0; i < recordsToWrite.length; i += batchSize) {
    const batch = recordsToWrite.slice(i, i + batchSize);
    console.log(
      `${DRY_RUN ? "Would write" : "Writing"} ${batch.length} record(s) to price_list_id=${priceListId}`
    );
    if (!DRY_RUN) await bcPut(`/pricelists/${priceListId}/records/batch`, batch);
  }
}

export async function run(customerGroupIds = [], fallbackRule = null) {
  const variants = await activeVariants();
  const variantsById = Object.fromEntries(variants.map((v) => [v.id, v]));
  const activeIds = new Set(Object.keys(variantsById).map(Number));

  const mapping = await groupToPriceList(customerGroupIds);
  const priceListIds = new Set(Object.values(mapping));

  let allRecords = [];
  for (const priceListId of priceListIds) {
    allRecords = allRecords.concat(await priceListRecords(priceListId));
  }

  const gaps = findVariantPriceGaps(activeIds, allRecords, mapping);
  const enriched = enrichGaps(gaps, variantsById);

  console.log(`Found ${enriched.length} variant price gap(s) across ${priceListIds.size} price list(s).`);
  console.log(JSON.stringify(enriched, null, 2));

  if (fallbackRule) {
    const byPriceList = {};
    for (const gap of enriched) {
      (byPriceList[gap.price_list_id] ||= []).push(gap);
    }
    for (const [priceListId, gapRows] of Object.entries(byPriceList)) {
      const recordsToWrite = gapRows.map((row) => fallbackRule(row, variantsById));
      await applyFallback(priceListId, recordsToWrite);
    }
  }

  return enriched;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
