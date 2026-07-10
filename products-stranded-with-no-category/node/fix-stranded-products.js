/**
 * Find and safely repair BigCommerce products with no category assigned.
 *
 * A product's categories field is just an array of category ids, and nothing
 * about creating a product through POST /v3/catalog/products or a bulk import
 * requires that array to be non-empty. When it ships empty, the product saves
 * fine and stays reachable by direct link, but it never appears on any category
 * page, navigation menu, or facet a normal shopper uses to browse.
 *
 * This scans every product with GET /v3/catalog/products, classifies each one
 * with a pure function, and for every stranded product (an empty categories
 * array) assigns one clearly labeled fallback category with a single PUT. It
 * never guesses a specific category from the product name, and it never touches
 * a product that already has at least one category. Guarded by DRY_RUN. Safe to
 * run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/products-stranded-with-no-category/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const FALLBACK_CATEGORY_ID = Number(process.env.FALLBACK_CATEGORY_ID || 0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure classification. No network calls.
 *
 * product: { id, name, categories: [int, ...] }
 *
 * Returns true only when the product's categories array is missing or
 * empty. A product with even one category id already is not stranded and
 * is left completely alone.
 */
export function isStranded(product) {
  const categories = product.categories || [];
  return categories.length === 0;
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
    const batch = await bc("GET", `/v3/catalog/products?limit=${limit}&page=${page}`);
    if (!batch || !batch.length) return;
    for (const product of batch) yield product;
    if (batch.length < limit) return;
    page += 1;
  }
}

async function assignFallbackCategory(productId, fallbackCategoryId) {
  return bc("PUT", `/v3/catalog/products/${productId}`, { categories: [fallbackCategoryId] });
}

export async function run() {
  if (!FALLBACK_CATEGORY_ID) {
    throw new Error("FALLBACK_CATEGORY_ID must be set to a real category id before running.");
  }

  let fixed = 0;
  for await (const product of allProducts()) {
    if (!isStranded(product)) continue;
    console.log(
      `Product ${product.id} (${product.name}) has no category. ${DRY_RUN ? "would assign fallback" : "assigning fallback"}`
    );
    if (!DRY_RUN) await assignFallbackCategory(product.id, FALLBACK_CATEGORY_ID);
    fixed++;
  }
  console.log(`Done. ${fixed} product(s) ${DRY_RUN ? "to assign" : "assigned a fallback category"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
