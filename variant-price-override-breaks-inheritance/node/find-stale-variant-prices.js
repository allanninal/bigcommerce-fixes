/**
 * Report BigCommerce variants whose price no longer follows the product price.
 *
 * A variant's price field is nullable and independent of the parent product's
 * price. If it is null, the storefront falls back to the product's default
 * price, but once a merchant or an API call sets an explicit numeric value on
 * that variant, it decouples permanently. A later PUT that updates the
 * product's price never cascades to variants that already carry a non-null
 * price, sale_price, or retail_price, and the API returns 200 with no warning
 * that variants were left behind. This job pages the full catalog with
 * variants included, compares each variant's price against its product's
 * price using precise decimal-string arithmetic, and writes a report of every
 * divergence. A diverging variant price can be intentional (a size or
 * material upcharge), so nothing is reset automatically. Only variant ids the
 * merchant explicitly confirms are passed to resetVariantPrice, and even then
 * DRY_RUN gates the real write. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/variant-price-override-breaks-inheritance/
 */
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_EPSILON = "0.0001";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// --- Precise decimal-string arithmetic, no floating point ---
// Scales both operands to the same number of decimal digits and works in
// integers (BigInt), so 4-decimal-place BigCommerce money never hits float
// rounding error.

function decimalParts(value) {
  const str = String(value).trim();
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [whole, frac = ""] = unsigned.split(".");
  return { negative, whole: whole || "0", frac };
}

function toScaledInt(value, scale) {
  const { negative, whole, frac } = decimalParts(value);
  const paddedFrac = (frac + "0".repeat(scale)).slice(0, scale);
  const digits = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  const n = BigInt(digits || "0");
  return negative ? -n : n;
}

function scaleOf(value) {
  const { frac } = decimalParts(value);
  return frac.length;
}

function formatScaledInt(n, scale) {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? "" : digits.slice(-scale);
  const body = scale === 0 ? whole : `${whole}.${frac}`;
  return negative && n !== 0n ? `-${body}` : body;
}

function subtractDecimalStrings(a, b) {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const diff = toScaledInt(a, scale) - toScaledInt(b, scale);
  return formatScaledInt(diff, scale);
}

function compareAbsDecimalStrings(value, epsilon) {
  const scale = Math.max(scaleOf(value), scaleOf(epsilon));
  const v = toScaledInt(value, scale);
  const abs = v < 0n ? -v : v;
  const e = toScaledInt(epsilon, scale);
  return abs > e ? 1 : abs < e ? -1 : 0;
}

function isParseableDecimal(value) {
  return /^-?\d+(\.\d+)?$/.test(String(value).trim());
}

/**
 * Pure decision. No network, no side effects.
 *
 * product: {id, price}
 * variants: list of {id, sku, price}
 *
 * Returns one entry per variant whose non-null price differs from
 * product.price by more than epsilon, using precise decimal-string
 * arithmetic only on inputs already fetched. A null, undefined, or empty
 * variant price means the variant is still inheriting and is never a
 * finding. An unparseable price is skipped, never thrown.
 */
export function findStaleVariantOverrides(product, variants, epsilon = DEFAULT_EPSILON) {
  if (product == null || product.price === undefined || product.price === null) return [];
  if (!isParseableDecimal(product.price)) return [];

  const findings = [];
  for (const variant of variants || []) {
    const raw = variant.price;
    if (raw === null || raw === undefined || raw === "") continue;
    if (!isParseableDecimal(raw)) continue;

    const delta = subtractDecimalStrings(String(raw), String(product.price));
    if (compareAbsDecimalStrings(delta, String(epsilon)) <= 0) continue;

    findings.push({
      variant_id: variant.id,
      sku: variant.sku,
      product_price: String(product.price),
      variant_price: String(raw),
      delta,
    });
  }

  return findings;
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
  let page = 1;
  while (true) {
    const payload = await bcGet("/catalog/products", {
      include: "variants",
      limit: 250,
      page,
    });
    for (const product of payload.data || []) yield product;
    const totalPages = payload.meta?.pagination?.total_pages ?? page;
    if (page >= totalPages) return;
    page += 1;
  }
}

async function buildReport() {
  const rows = [];
  for await (const product of allProductsWithVariants()) {
    const variants = product.variants || [];
    for (const finding of findStaleVariantOverrides(product, variants)) {
      rows.push({
        product_id: product.id,
        product_name: product.name,
        product_price: finding.product_price,
        variant_id: finding.variant_id,
        variant_sku: finding.sku,
        variant_price: finding.variant_price,
        delta: finding.delta,
      });
    }
  }
  return rows;
}

function toCsv(rows) {
  const fields = ["product_id", "product_name", "product_price", "variant_id", "variant_sku", "variant_price", "delta"];
  const escape = (value) => {
    const s = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fields.join(",")];
  for (const row of rows) lines.push(fields.map((f) => escape(row[f])).join(","));
  return lines.join("\n");
}

/**
 * Clear a single, merchant-confirmed variant back to inheriting the
 * product's price. Never call this in bulk. DRY_RUN gates the real write.
 */
async function resetVariantPrice(productId, variantId, alsoClearSalePrice = false) {
  const body = { price: null };
  if (alsoClearSalePrice) body.sale_price = null;

  if (DRY_RUN) {
    console.log(`DRY_RUN: would PUT /catalog/products/${productId}/variants/${variantId} with ${JSON.stringify(body)}`);
    return null;
  }

  console.log(`Resetting variant ${variantId} on product ${productId}: ${JSON.stringify(body)}`);
  return bcPut(`/catalog/products/${productId}/variants/${variantId}`, body);
}

export async function run(confirmedVariantIds = []) {
  const confirmed = new Set(confirmedVariantIds);

  const rows = await buildReport();
  await writeFile("stale_variant_overrides.json", JSON.stringify(rows, null, 2));
  await writeFile("stale_variant_overrides.csv", toCsv(rows));
  console.log(`Wrote ${rows.length} row(s) to stale_variant_overrides.json and .csv`);

  let resetCount = 0;
  for (const row of rows) {
    if (!confirmed.has(row.variant_id)) continue;
    await resetVariantPrice(row.product_id, row.variant_id);
    resetCount += 1;
  }

  console.log(
    `Done. ${rows.length} divergent variant(s) reported, ${resetCount} variant(s) ${DRY_RUN ? "would be reset" : "reset"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const confirmed = process.argv.slice(2).filter((v) => /^\d+$/.test(v)).map(Number);
  run(confirmed).catch((err) => { console.error(err); process.exit(1); });
}
