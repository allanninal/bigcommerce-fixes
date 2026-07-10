/**
 * Find and safely repair BigCommerce variants that oversold into negative inventory.
 *
 * inventory_level on a variant is meant to floor at zero. But when two checkouts
 * decrement the same low-stock SKU at nearly the same moment, or a bulk import
 * writes a negative delta, or a channel sync double counts a sale, the number can
 * end up below zero. BigCommerce keeps selling a SKU that reads -3 exactly the same
 * as one that reads 30, because nothing in checkout refuses a negative count.
 *
 * This scans every product with GET /v3/catalog/products?include=variants, finds
 * variants whose inventory_level is below zero, and classifies each one with a pure
 * function. A negative count on a product with inventory_tracking off is not really
 * a stock problem and is left alone. A negative count on a tracked variant is
 * repaired by posting an absolute adjustment back to zero with
 * POST /v3/inventory/adjustments/absolute, and the lost quantity is kept in the
 * result so it can be logged for restock and demand planning. Guarded by DRY_RUN.
 * Safe to run again and again, since a variant already at zero or above is skipped.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/negative-inventory-from-overselling/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ADJUSTMENT_REASON = process.env.ADJUSTMENT_REASON || "negative_inventory_overselling_repair";

/**
 * Pure classification. No network calls.
 *
 * product: { id, inventory_tracking: "none" | "product" | "variant" }
 * variant: { id, sku, inventory_level }
 *
 * Returns { productId, variantId, sku, needsFix, oversoldBy }.
 *
 * 1. If the product does not track inventory at the variant level, a negative
 *    number on that variant is cosmetic, not a real oversell, so it is left alone.
 * 2. If inventory_level is zero or positive, there is nothing to repair.
 * 3. Otherwise the variant is genuinely oversold. oversoldBy is the positive
 *    quantity that sold past zero, kept so the caller can log it for restock
 *    and demand planning before the count is corrected back to zero.
 */
export function classifyNegativeInventory(product, variant) {
  if (product.inventory_tracking !== "variant") {
    return { productId: product.id, variantId: variant.id, sku: variant.sku, needsFix: false, oversoldBy: 0 };
  }

  const level = variant.inventory_level ?? 0;
  if (level >= 0) {
    return { productId: product.id, variantId: variant.id, sku: variant.sku, needsFix: false, oversoldBy: 0 };
  }

  return { productId: product.id, variantId: variant.id, sku: variant.sku, needsFix: true, oversoldBy: Math.abs(level) };
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

async function resetVariantToZero(sku, reason) {
  const payload = { reason, items: [{ sku, quantity: 0 }] };
  return bc("POST", "/v3/inventory/adjustments/absolute", payload);
}

export async function run() {
  let repaired = 0;
  let totalOversold = 0;
  for await (const product of allProducts()) {
    for (const variant of product.variants || []) {
      const decision = classifyNegativeInventory(product, variant);
      if (!decision.needsFix) continue;

      console.warn(
        `SKU ${decision.sku} (variant ${decision.variantId}) oversold by ${decision.oversoldBy} units. ${DRY_RUN ? "would reset to 0" : "resetting to 0"}`
      );
      if (!DRY_RUN) await resetVariantToZero(decision.sku, ADJUSTMENT_REASON);
      repaired++;
      totalOversold += decision.oversoldBy;
    }
  }
  console.log(`Done. ${repaired} variant(s) ${DRY_RUN ? "to reset" : "reset to 0"}, ${totalOversold} unit(s) oversold in total.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
