/**
 * Find and safely repair BigCommerce products whose variant inventory is not tracked.
 *
 * inventory_tracking on the parent product is a tri-state setting: "none", "product",
 * or "variant". It is independent of whether the product actually has variants. A
 * product can have real size or color SKUs, each carrying its own inventory_level,
 * while inventory_tracking stays at "none" or "product". In that state BigCommerce's
 * checkout never reads or decrements per-SKU stock, so a variant can sell forever no
 * matter what number is displayed in the admin.
 *
 * This scans every product with GET /v3/catalog/products?include=variants, classifies
 * each one with a pure function, and for products that need a fix, checks whether
 * every affected variant already has a non-null inventory_level. If so it is safe to
 * flip inventory_tracking to "variant" with one PUT. If any variant has no stock
 * count yet, the product is only flagged, never auto-repaired, since enabling
 * tracking on a missing count would show a false zero and block real sales. Guarded
 * by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/variant-inventory-not-tracked/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure classification. No network calls.
 *
 * product: { id, inventory_tracking: "none" | "product" | "variant",
 *            variants: [{ id, sku, inventory_level }] }
 *
 * Returns { productId, needsFix, reason, affectedVariantIds }.
 *
 * 1. A product with one or zero variants is left alone, since a single default
 *    variant is expected even for simple products.
 * 2. A product already tracking at "variant" is already correctly configured.
 * 3. Otherwise, a product with real option-level SKUs (more than one variant) and
 *    tracking at "none" or "product" needs a fix. Every variant id is returned as
 *    affected so the caller can check their inventory_level before repairing.
 */
export function classifyVariantTracking(product) {
  const variants = product.variants || [];
  if (variants.length <= 1) {
    return { productId: product.id, needsFix: false, reason: null, affectedVariantIds: [] };
  }

  if (product.inventory_tracking === "variant") {
    return { productId: product.id, needsFix: false, reason: null, affectedVariantIds: [] };
  }

  const reason =
    product.inventory_tracking === "none"
      ? "tracking_disabled_entirely"
      : "tracking_set_to_product_level_not_variant";

  return {
    productId: product.id,
    needsFix: true,
    reason,
    affectedVariantIds: variants.map((v) => v.id),
  };
}

/**
 * True only when every affected variant already has a non-null inventory_level.
 * This is the safety guard: flipping inventory_tracking to "variant" on a variant
 * whose stock was never counted would show it as zero and block sales.
 */
export function allVariantsHaveStock(variants, affectedIds) {
  const byId = new Map(variants.map((v) => [v.id, v]));
  return affectedIds.every((vid) => (byId.get(vid) || {}).inventory_level != null);
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
  const json = JSON.parse(text);
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

async function* allProducts() {
  let page = 1;
  const limit = 250;
  while (true) {
    const batch = await bc("GET", `/v3/catalog/products?include=variants&limit=${limit}&page=${page}`);
    if (!batch || !batch.length) return;
    for (const product of batch) yield product;
    if (batch.length < limit) return;
    page += 1;
  }
}

/** The one field write: turn on per-SKU tracking. No stock count is sent or mutated. */
async function setVariantTracking(productId) {
  return bc("PUT", `/v3/catalog/products/${productId}`, { inventory_tracking: "variant" });
}

export async function run() {
  let repaired = 0;
  let flagged = 0;
  for await (const product of allProducts()) {
    const decision = classifyVariantTracking(product);
    if (!decision.needsFix) continue;

    const variants = product.variants || [];
    if (!allVariantsHaveStock(variants, decision.affectedVariantIds)) {
      console.warn(
        `Product ${decision.productId} needs a fix (${decision.reason}) but has a variant with no inventory_level. Flagging for review.`
      );
      flagged++;
      continue;
    }

    console.log(
      `Product ${decision.productId} eligible (${decision.reason}). ${DRY_RUN ? "would set inventory_tracking=variant" : "setting inventory_tracking=variant"}`
    );
    if (!DRY_RUN) {
      const result = await setVariantTracking(decision.productId);
      console.log(`Product ${decision.productId} inventory_tracking is now ${result && result.inventory_tracking}`);
    }
    repaired++;
  }
  console.log(`Done. ${repaired} product(s) ${DRY_RUN ? "to repair" : "repaired"}, ${flagged} product(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
