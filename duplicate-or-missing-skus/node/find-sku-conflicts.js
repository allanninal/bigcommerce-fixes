/**
 * Find duplicate and missing SKUs across a BigCommerce catalog, and flag them.
 *
 * BigCommerce only validates SKU uniqueness at write time, on a POST or PUT to
 * /v3/catalog/products or its /variants sub-resource, which returns a 422 if the
 * value collides with an existing one. It never retroactively scans the catalog,
 * so duplicates and blanks that entered through CSV bulk imports, multi-channel or
 * POS/ERP sync tools, or the Admin's Duplicate product action persist undetected.
 *
 * This pages through GET /v3/catalog/products?include=variants&limit=250 across
 * the full catalog, flattens each product and its variants into SKU records,
 * classifies them with a pure function, and in write mode appends a custom_fields
 * marker to each conflicting product or variant. It never rewrites a SKU itself.
 * Guarded by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/duplicate-or-missing-skus/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "dummy_store_hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function classifySkuConflicts(records) {
  const groups = new Map();
  const missing = [];

  for (const record of records) {
    const sku = record.sku;
    const normalized = typeof sku === "string" ? sku.trim().toLowerCase() : "";
    if (!normalized) {
      missing.push({ id: record.id, parentProductId: record.parentProductId ?? null });
      continue;
    }
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push(record.id);
  }

  const duplicates = [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([normalizedSku, recordIds]) => ({ normalizedSku, recordIds }))
    .sort((a, b) => (a.normalizedSku < b.normalizedSku ? -1 : a.normalizedSku > b.normalizedSku ? 1 : 0));

  missing.sort((a, b) => a.id - b.id);

  return { duplicates, missing };
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

async function* allProducts() {
  const limit = 250;
  let page = 1;
  while (true) {
    const batch = await bc("GET", `/v3/catalog/products?include=variants&limit=${limit}&page=${page}`);
    if (!batch || !batch.length) return;
    for (const product of batch) yield product;
    if (batch.length < limit) return;
    page += 1;
  }
}

function skuRecords(product) {
  const records = [{ id: product.id, parentProductId: null, sku: product.sku }];
  for (const variant of product.variants || []) {
    records.push({ id: variant.id, parentProductId: product.id, sku: variant.sku });
  }
  return records;
}

async function flagProduct(productId, markerValue) {
  return bc("PUT", `/v3/catalog/products/${productId}`, {
    custom_fields: [{ name: "sku_conflict", value: markerValue }],
  });
}

async function flagVariant(productId, variantId, markerValue) {
  return bc("PUT", `/v3/catalog/products/${productId}/variants/${variantId}`, {
    custom_fields: [{ name: "sku_conflict", value: markerValue }],
  });
}

export async function run() {
  const allRecords = [];
  for await (const product of allProducts()) {
    allRecords.push(...skuRecords(product));
  }

  const { duplicates, missing } = classifySkuConflicts(allRecords);

  for (const dup of duplicates) {
    const ids = dup.recordIds.join(",");
    const marker = `duplicate:${dup.normalizedSku}|ids:${ids}`;
    console.warn(`Duplicate SKU "${dup.normalizedSku}" across ids ${ids}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) {
      for (const recordId of dup.recordIds) await flagProduct(recordId, marker);
    }
  }

  for (const miss of missing) {
    console.warn(`Missing SKU on id ${miss.id} (parentProductId=${miss.parentProductId}). ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) {
      if (miss.parentProductId === null) await flagProduct(miss.id, "missing_sku");
      else await flagVariant(miss.parentProductId, miss.id, "missing_sku");
    }
  }

  console.log(`Done. ${duplicates.length} duplicate group(s) and ${missing.length} missing SKU(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
