/**
 * Detect BigCommerce variant inventory writes that silently fail past int32 max.
 *
 * BigCommerce's Catalog v3 API stores inventory_level as a 32-bit signed integer
 * with a ceiling of 2147483647, and it enforces that ceiling against the product's
 * summed variant inventory, not just the single variant being written. A write via
 * PUT /v3/catalog/products/{id}/variants/{variant_id}, the Update Products batch
 * endpoint, or POST /v3/inventory/adjustments/absolute|relative that would push
 * that sum over the ceiling does not get clamped and does not return a validation
 * error. It returns HTTP 200 and the stored inventory_level is left unchanged.
 * This job predicts the overflow before writing using only pre-fetched variant
 * levels (no network call needed for the decision itself), and after every write
 * it re-reads the same variant directly to confirm the value actually changed.
 * Everything it finds is reported, nothing is auto-corrected.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/inventory-int32-overflow-silent-failure/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const INT32_MAX = 2147483647;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * totalExcludingTarget = sum of every other variant's level.
 * projectedSum = totalExcludingTarget + newLevel.
 * isUnsafe when projectedSum exceeds int32Max, or when newLevel alone already
 * exceeds int32Max. Returns [isUnsafe, projectedSum] so the caller can log the
 * projected total whether or not it is unsafe.
 */
export function wouldOverflowAndBeDropped(currentVariantLevels, variantId, newLevel, int32Max = INT32_MAX) {
  const totalExcludingTarget = currentVariantLevels
    .filter((v) => v.id !== variantId)
    .reduce((sum, v) => sum + v.level, 0);
  const projectedSum = totalExcludingTarget + newLevel;
  const isUnsafe = projectedSum > int32Max || newLevel > int32Max;
  return [isUnsafe, projectedSum];
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

async function listVariants(productId) {
  const variants = [];
  let page = 1;
  while (true) {
    const resp = await bcGet(`/catalog/products/${productId}/variants`, {
      limit: 250,
      page,
      include_fields: "id,sku,inventory_level",
    });
    const rows = resp.data || [];
    if (!rows.length) return variants;
    variants.push(...rows);
    page += 1;
  }
}

async function getVariant(productId, variantId) {
  const resp = await bcGet(`/catalog/products/${productId}/variants/${variantId}`);
  return resp.data;
}

async function writeVariantInventoryLevel(productId, variantId, newLevel) {
  return bcPut(`/catalog/products/${productId}/variants/${variantId}`, {
    inventory_level: newLevel,
  });
}

async function checkAndApply(productId, variantId, sku, newLevel) {
  const variants = await listVariants(productId);
  const levels = variants.map((v) => ({ id: v.id, level: v.inventory_level || 0 }));

  const before = await getVariant(productId, variantId);
  const currentPersisted = before.inventory_level;

  const [isUnsafe, projectedSum] = wouldOverflowAndBeDropped(levels, variantId, newLevel);

  if (isUnsafe) {
    console.warn(
      `Predicted overflow: product_id=${productId} variant_id=${variantId} sku=${sku} ` +
      `attempted=${newLevel} current=${currentPersisted} projected_sum=${projectedSum}`
    );
    return {
      product_id: productId,
      variant_id: variantId,
      sku,
      attempted_inventory_level: newLevel,
      current_persisted_inventory_level: currentPersisted,
      projected_sum: projectedSum,
    };
  }

  if (DRY_RUN) {
    console.log(
      `Dry run, would write: product_id=${productId} variant_id=${variantId} sku=${sku} ` +
      `attempted=${newLevel} current=${currentPersisted} projected_sum=${projectedSum}`
    );
    return null;
  }

  await writeVariantInventoryLevel(productId, variantId, newLevel);
  const after = await getVariant(productId, variantId);

  if (after.inventory_level === currentPersisted && newLevel !== currentPersisted) {
    console.warn(
      `Silent failure detected: product_id=${productId} variant_id=${variantId} sku=${sku} ` +
      `attempted=${newLevel} current=${currentPersisted} (unchanged after 200 response) projected_sum=${projectedSum}`
    );
    return {
      product_id: productId,
      variant_id: variantId,
      sku,
      attempted_inventory_level: newLevel,
      current_persisted_inventory_level: after.inventory_level,
      projected_sum: projectedSum,
    };
  }

  return null;
}

export async function run(pendingWrites) {
  const reports = [];
  for (const [productId, variantId, sku, newLevel] of pendingWrites) {
    const report = await checkAndApply(productId, variantId, sku, newLevel);
    if (report) reports.push(report);
  }

  console.log(`Done. ${reports.length} mismatch(es) reported.`);
  return reports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run([]).catch((err) => { console.error(err); process.exit(1); });
}
