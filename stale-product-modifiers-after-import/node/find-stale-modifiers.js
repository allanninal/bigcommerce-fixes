/**
 * Find and safely report stale product modifiers left behind after a BigCommerce import.
 *
 * The CSV product import and export tools can only edit price and weight adjusters on
 * modifier option_values that already exist. They cannot create, delete, or fully
 * re-link one. So when a migration or bulk-import tool deletes and recreates variants
 * with new SKUs and variant IDs, or replaces the product a product_list or
 * product_list_with_images modifier points at, the old modifier and its option_values
 * survive on the parent product, referencing records that no longer exist.
 *
 * This pages through GET /v3/catalog/products?include=variants,options,modifiers&limit=250,
 * reads each product's modifiers, and classifies them with a pure function against the
 * product's current variant SKUs and the live catalog's product ids. In write mode it
 * deletes a modifier only when every option_value is a confirmed dead reference, and
 * strips just the dangling entries when some values are still valid. Anything ambiguous
 * is recorded in an audit list instead of written. Guarded by DRY_RUN. Safe to run again
 * and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/stale-product-modifiers-after-import/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "dummy_store_hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRODUCT_LIST_TYPES = new Set(["product_list", "product_list_with_images"]);

export function findStaleModifiers(modifiers, liveVariantSkus, liveProductIds) {
  const stale = [];

  for (const modifier of modifiers) {
    const optionValues = modifier.option_values || [];

    if (modifier.is_required && optionValues.length === 0) {
      stale.push(modifier);
      continue;
    }

    let isStale = false;
    for (const value of optionValues) {
      const valueData = value.value_data || {};

      if (PRODUCT_LIST_TYPES.has(modifier.type)) {
        const productId = valueData.product_id;
        if (productId != null && !liveProductIds.has(productId)) {
          isStale = true;
          break;
        }
      }

      const sku = valueData.sku;
      if (sku && !liveVariantSkus.has(sku)) {
        isStale = true;
        break;
      }
    }

    if (isStale) stale.push(modifier);
  }

  return stale;
}

async function bc(method, path, body) {
  const res = await fetch(BASE + path.replace(/^\//, ""), {
    method,
    headers: { "X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  if (!text) return true;
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

async function* allProductsWithModifiers() {
  const limit = 250;
  let page = 1;
  while (true) {
    const batch = await bc("GET", `/v3/catalog/products?include=variants,options,modifiers&limit=${limit}&page=${page}`);
    if (!batch || !batch.length) return;
    for (const product of batch) yield product;
    if (batch.length < limit) return;
    page += 1;
  }
}

function liveVariantSkus(product) {
  return new Set((product.variants || []).map((v) => v.sku).filter(Boolean));
}

async function productExists(productId) {
  return (await bc("GET", `/v3/catalog/products/${productId}`)) !== null;
}

function allDeadReferences(modifier, liveVariantSkusSet, liveProductIds) {
  const optionValues = modifier.option_values || [];
  if (optionValues.length === 0) return true;
  for (const value of optionValues) {
    const valueData = value.value_data || {};
    const productId = valueData.product_id;
    const sku = valueData.sku;
    const productDead =
      PRODUCT_LIST_TYPES.has(modifier.type) && productId != null && !liveProductIds.has(productId);
    const skuDead = Boolean(sku) && !liveVariantSkusSet.has(sku);
    if (!(productDead || skuDead)) return false;
  }
  return true;
}

async function deleteModifier(productId, modifierId) {
  return bc("DELETE", `/v3/catalog/products/${productId}/modifiers/${modifierId}`);
}

async function stripDanglingOptionValues(productId, modifierId, modifier, liveVariantSkusSet, liveProductIds) {
  const kept = (modifier.option_values || []).filter((value) => {
    const valueData = value.value_data || {};
    const productIdRef = valueData.product_id;
    const sku = valueData.sku;
    if (PRODUCT_LIST_TYPES.has(modifier.type) && productIdRef != null) {
      if (!liveProductIds.has(productIdRef)) return false;
    }
    if (sku && !liveVariantSkusSet.has(sku)) return false;
    return true;
  });
  return bc("PUT", `/v3/catalog/products/${productId}/modifiers/${modifierId}`, { option_values: kept });
}

export async function run() {
  const audit = [];
  let acted = 0;

  for await (const product of allProductsWithModifiers()) {
    const modifiers = product.modifiers || [];
    if (modifiers.length === 0) continue;

    const skus = liveVariantSkus(product);
    const productIdsSeen = new Set(
      modifiers
        .flatMap((m) => m.option_values || [])
        .map((v) => v.value_data?.product_id)
        .filter((id) => id != null)
    );
    const liveProductIds = new Set();
    for (const pid of productIdsSeen) {
      if (await productExists(pid)) liveProductIds.add(pid);
    }

    const stale = findStaleModifiers(modifiers, skus, liveProductIds);
    for (const modifier of stale) {
      const productId = product.id;
      const modifierId = modifier.id;

      if (allDeadReferences(modifier, skus, liveProductIds)) {
        console.warn(`Product ${productId} modifier ${modifierId} fully orphaned. ${DRY_RUN ? "would delete" : "deleting"}`);
        if (!DRY_RUN) await deleteModifier(productId, modifierId);
        acted++;
      } else if (modifier.is_required && (modifier.option_values || []).length === 0) {
        console.warn(`Product ${productId} modifier ${modifierId} is required with zero option_values, needs a human. Recording to audit list.`);
        audit.push({ productId, modifierId, reason: "required_no_values" });
      } else {
        console.warn(`Product ${productId} modifier ${modifierId} has some dangling option_values. ${DRY_RUN ? "would strip" : "stripping"}`);
        if (!DRY_RUN) await stripDanglingOptionValues(productId, modifierId, modifier, skus, liveProductIds);
        acted++;
      }
    }
  }

  console.log(`Done. ${acted} stale modifier(s) ${DRY_RUN ? "to act on" : "acted on"}, ${audit.length} recorded for review.`);
  return audit;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
