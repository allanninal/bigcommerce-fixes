/**
 * Find and optionally repair BigCommerce variants left with colliding SKUs
 * after a product duplication.
 *
 * When BigCommerce duplicates a product, in the admin or through a script
 * cloning it via the Catalog API, it copies the full variant option matrix
 * but does not mint new SKU values for the cloned variants. It either
 * repeats the source product's SKU verbatim across every variant row or
 * leaves them blank. BigCommerce only enforces SKU uniqueness as a
 * write-time constraint, a 409 Conflict on save, rather than
 * auto-generating a unique SKU at duplication time, so the copy silently
 * persists with colliding SKUs until something else tries to write or
 * match on one. This job walks the catalog, groups each product's variant
 * SKUs, and reports every collision. Renaming is gated behind an explicit
 * --apply flag and DRY_RUN guard, because a SKU can be keyed against an
 * external inventory or ERP system.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/duplicate-product-creates-colliding-skus/
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const APPLY = process.argv.includes("--apply");

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Takes a flat list of variant records, each with product_id, variant_id,
 * sku, and option_values. Normalizes sku via trim().toLowerCase(), groups
 * variants by "product_id:normalizedSku", drops blank SKUs (not a
 * collision), and returns only groups with more than one variant.
 */
export function findSkuCollisions(variants) {
  const groups = new Map();

  for (const v of variants) {
    const normalizedSku = (v.sku || "").trim().toLowerCase();
    if (normalizedSku === "") continue;
    const key = `${v.product_id}:${normalizedSku}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  const collisions = {};
  for (const [key, rows] of groups) {
    if (rows.length > 1) collisions[key] = rows;
  }
  return collisions;
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

async function* allProductsWithVariants() {
  let path = "/catalog/products";
  let params = { include: "variants", limit: 250 };
  while (path) {
    const payload = params ? await bcGet(path, params) : await bcGet(path);
    for (const product of payload.data) yield product;
    const nextUrl = payload.meta && payload.meta.pagination && payload.meta.pagination.links
      ? payload.meta.pagination.links.next
      : null;
    path = nextUrl || null;
    params = null;
  }
}

function flattenVariants(products) {
  const out = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      out.push({
        product_id: product.id,
        variant_id: variant.id,
        sku: variant.sku || "",
        option_values: variant.option_values || [],
      });
    }
  }
  return out;
}

async function renameDuplicate(productId, variantId, originalSku) {
  const newSku = `${originalSku}-${variantId}`;
  return bcPut(`/catalog/products/${productId}/variants/${variantId}`, { sku: newSku });
}

function writeReport(collisions, path = "sku_collisions.csv") {
  const lines = ["product_id,variant_id,sku,option_values"];
  for (const rows of Object.values(collisions)) {
    for (const row of rows) {
      const optionValues = JSON.stringify(row.option_values).replace(/"/g, '""');
      lines.push(`${row.product_id},${row.variant_id},${row.sku},"${optionValues}"`);
    }
  }
  fs.writeFileSync(path, lines.join("\n"));
  return path;
}

export async function run() {
  const products = [];
  for await (const product of allProductsWithVariants()) products.push(product);
  const variants = flattenVariants(products);
  const collisions = findSkuCollisions(variants);

  if (Object.keys(collisions).length === 0) {
    console.log(`No colliding SKUs found across ${products.length} product(s).`);
    return;
  }

  const reportPath = writeReport(collisions);
  console.log(
    `Found ${Object.keys(collisions).length} colliding SKU group(s) across ${products.length} product(s). Report written to ${reportPath}`
  );

  for (const [key, rows] of Object.entries(collisions)) {
    console.warn(
      `Collision ${key}:`,
      rows.map((r) => ({ variant_id: r.variant_id, option_values: r.option_values }))
    );
  }

  if (!APPLY) {
    console.log("Report only. Pass --apply and set DRY_RUN=false to rename duplicates.");
    return;
  }

  let renamed = 0;
  for (const rows of Object.values(collisions)) {
    const [keep, ...duplicates] = rows;
    console.log(`Keeping original sku=${keep.sku} on variant_id=${keep.variant_id}`);
    for (const dup of duplicates) {
      if (DRY_RUN) {
        console.log(`Would rename variant_id=${dup.variant_id} sku=${dup.sku} -> ${dup.sku}-${dup.variant_id}`);
      } else {
        await renameDuplicate(dup.product_id, dup.variant_id, dup.sku);
        console.log(`Renamed variant_id=${dup.variant_id} sku=${dup.sku} -> ${dup.sku}-${dup.variant_id}`);
      }
      renamed += 1;
    }
  }

  console.log(`Done. ${renamed} duplicate variant(s) ${DRY_RUN ? "would be renamed" : "renamed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
