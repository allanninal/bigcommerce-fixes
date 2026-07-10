/**
 * Find BigCommerce products and variants that are out of stock but still purchasable.
 *
 * BigCommerce only blocks checkout for a SKU when three fields agree: inventory_tracking
 * is scoped correctly ("product" for simple products or "variant" for SKU-level options),
 * the matching inventory_level is at or below zero, and availability is not forced to
 * "available". A common break is inventory_tracking left at "none", or scoped at the
 * product level while stock is really managed per variant. In that state BigCommerce
 * never evaluates stock at all, so the storefront and API accept orders no matter what
 * inventory_level says. The same gap shows up after an import writes zero to a product
 * but not its variants, or after a dead inventory webhook leaves inventory_level stale.
 *
 * This scans every product with GET /v3/catalog/products?include=variants, classifies
 * each product and each of its variants with a pure function, and logs every "phantom
 * in-stock" record. This is a detect-and-flag tool: it never mutates live availability
 * on its own. A correction only runs for a product id you pass in CONFIRMED_PRODUCT_IDS,
 * meaning a human has verified the product should truly be disabled, and even then it is
 * guarded by DRY_RUN and re-reads the record afterward to confirm the write persisted.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/out-of-stock-but-still-purchasable/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Product ids a human has explicitly confirmed should be corrected. Left empty by
// default so the script only ever flags until you deliberately opt a product in.
const CONFIRMED_PRODUCT_IDS = new Set(
  (process.env.CONFIRMED_PRODUCT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
);

const TRACKED_MODES = new Set(["product", "variant"]);
const CORRECTION_PAYLOAD = { inventory_tracking: "product", inventory_level: 0, availability: "disabled" };

/**
 * Pure decision. No network calls, no side effects.
 *
 * Returns true (flag as "out of stock but still purchasable") only when
 * inventoryTracking is "product" or "variant", inventoryLevel is at or below
 * zero, availability is "available", and purchasingDisabled is false. Returns
 * false for untracked SKUs, correctly disabled SKUs, or SKUs genuinely still
 * in stock.
 */
export function isStaleInStock(inventoryTracking, inventoryLevel, availability, purchasingDisabled) {
  if (!TRACKED_MODES.has(inventoryTracking)) return false;
  if (inventoryLevel > 0) return false;
  if (availability !== "available") return false;
  return purchasingDisabled === false;
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

function* flaggedRecords(product) {
  if (
    isStaleInStock(
      product.inventory_tracking,
      product.inventory_level ?? 0,
      product.availability,
      product.purchasing_disabled ?? false
    )
  ) {
    yield { kind: "product", id: product.id, sku: product.sku || "" };
  }

  for (const variant of product.variants || []) {
    if (
      isStaleInStock(
        product.inventory_tracking,
        variant.inventory_level ?? 0,
        product.availability,
        variant.purchasing_disabled ?? false
      )
    ) {
      yield { kind: "variant", id: variant.id, sku: variant.sku || "" };
    }
  }
}

async function disableConfirmedProduct(productId) {
  // Only call this for a productId present in CONFIRMED_PRODUCT_IDS.
  await bc("PUT", `/v3/catalog/products/${productId}`, CORRECTION_PAYLOAD);
  const confirmed = await bc("GET", `/v3/catalog/products/${productId}`);
  const ok = confirmed.inventory_level === 0 && confirmed.availability === "disabled";
  if (!ok) throw new Error(`Product ${productId} did not persist the correction`);
  return confirmed;
}

export async function run() {
  let flagged = 0;
  let corrected = 0;
  for await (const product of allProducts()) {
    for (const record of flaggedRecords(product)) {
      flagged++;
      console.warn(`${record.kind} ${record.id} (sku=${record.sku}) is out of stock but still purchasable.`);
      if (record.kind === "product" && CONFIRMED_PRODUCT_IDS.has(record.id)) {
        console.log(`Product ${record.id} is confirmed. ${DRY_RUN ? "would disable" : "disabling"}`);
        if (!DRY_RUN) await disableConfirmedProduct(record.id);
        corrected++;
      }
    }
  }
  console.log(`Done. ${flagged} record(s) flagged, ${corrected} confirmed product(s) ${DRY_RUN ? "to correct" : "corrected"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
