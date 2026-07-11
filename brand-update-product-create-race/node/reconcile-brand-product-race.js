/**
 * Reconcile a BigCommerce brand update fired immediately before a product create
 * that came back as an empty reply from server.
 *
 * BigCommerce enforces a per-store request quota (150 to 450 requests per 30
 * second OAuth window depending on plan) and a concurrency cap, normally
 * surfaced as a 429 with X-Rate-Limit-Requests-Left and
 * X-Rate-Limit-Time-Reset-Ms headers. When a brand PUT to
 * /v3/catalog/brands/{id} is fired immediately before a product POST to
 * /v3/catalog/products, the store's connection sometimes closes before the
 * response finishes, which HTTP clients surface as a generic empty reply
 * instead of a structured error. The underlying mutation may have actually
 * succeeded server side even though the client received nothing parsable.
 * This is a confirmed, reproduced issue in BigCommerce's own bigcommerce-api-php
 * SDK repo (issue #138).
 *
 * This job takes logged {brandId, intendedFields, productPayload} pairs,
 * confirms whether the brand update actually applied, checks whether the
 * product already exists from the failed attempt, and only retries the create
 * when it is safe: brand confirmed, product confirmed absent, and rate limit
 * budget or backoff allows another call. Anything else is flagged for manual
 * review, never auto-repaired.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/brand-update-product-create-race/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 5);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision logic, no I/O. Returns one of:
 *
 * "noop_success"        - brandConfirmed and productExists: pair actually
 *                          succeeded despite empty reply.
 * "retry_create"        - brandConfirmed, not productExists, rateLimitLeft
 *                          > 0, attempt < maxAttempts: safe to retry create.
 * "wait_and_retry"      - rateLimitLeft <= 0 and attempt < maxAttempts:
 *                          back off before retrying.
 * "flag_manual_review"  - not brandConfirmed (brand update itself never
 *                          applied): don't create against a stale brand.
 * "give_up"             - attempt >= maxAttempts and not productExists:
 *                          surface for manual review.
 */
export function decideAction(brandConfirmed, productExists, rateLimitLeft, attempt, maxAttempts = 5) {
  if (brandConfirmed && productExists) return "noop_success";
  if (!brandConfirmed) return "flag_manual_review";
  if (attempt >= maxAttempts && !productExists) return "give_up";
  if (rateLimitLeft <= 0) return "wait_and_retry";
  return "retry_create";
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const rateLimitLeft = Number(res.headers.get("X-Rate-Limit-Requests-Left") || "1");
  const body = await res.json();
  return { body, rateLimitLeft };
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function confirmBrandUpdate(brandId, intendedFields) {
  const { body, rateLimitLeft } = await bcGet(`/catalog/brands/${brandId}`);
  const brand = body.data || {};
  const matches = Object.entries(intendedFields).every(([field, value]) => brand[field] === value);
  return { matches, rateLimitLeft };
}

async function findExistingProduct(name, brandId) {
  const { body, rateLimitLeft } = await bcGet("/catalog/products", { name, brand_id: brandId });
  const products = body.data || [];
  return { product: products[0] || null, rateLimitLeft };
}

async function createProduct(productPayload) {
  return bcPost("/catalog/products", productPayload);
}

function backoffSeconds(attempt) {
  return Math.min(2 ** attempt, 8);
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function reconcilePair(brandId, intendedFields, productPayload) {
  let attempt = 0;
  for (;;) {
    const { matches: brandConfirmed } = await confirmBrandUpdate(brandId, intendedFields);
    const { product: existing, rateLimitLeft } = await findExistingProduct(productPayload.name, brandId);
    const productExists = existing !== null;

    const decision = decideAction(brandConfirmed, productExists, rateLimitLeft, attempt, MAX_ATTEMPTS);

    console.log(
      `brand_id=${brandId} attempt=${attempt} brand_confirmed=${brandConfirmed} ` +
      `product_exists=${productExists} rate_limit_left=${rateLimitLeft} decision=${decision}`
    );

    if (decision === "noop_success") return "noop_success";
    if (decision === "flag_manual_review") {
      console.warn(`Brand ${brandId} update not confirmed. Flagging pair for manual review.`);
      return "flag_manual_review";
    }
    if (decision === "give_up") {
      console.warn(`Brand ${brandId} exhausted ${MAX_ATTEMPTS} attempts. Flagging for manual review.`);
      return "give_up";
    }
    if (decision === "wait_and_retry") {
      const waitFor = backoffSeconds(attempt);
      console.log(`Rate limit exhausted, waiting ${waitFor}s before retry.`);
      if (!DRY_RUN) await sleep(waitFor);
      attempt += 1;
      continue;
    }

    // decision === "retry_create"
    if (DRY_RUN) {
      console.log(`Dry run: would create product ${productPayload.name} under brand ${brandId}.`);
      return "retry_create";
    }

    const { product: recheck } = await findExistingProduct(productPayload.name, brandId);
    if (recheck !== null) {
      console.log("Product appeared before retry. Treating as noop_success.");
      return "noop_success";
    }

    await createProduct(productPayload);
    console.log(`Created product ${productPayload.name} under brand ${brandId}.`);
    return "created";
  }
}

export async function run(pairs = []) {
  const results = [];
  for (const { brandId, intendedFields, productPayload } of pairs) {
    results.push(await reconcilePair(brandId, intendedFields, productPayload));
  }
  console.log(`Done. ${results.length} pair(s) processed.`);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run([]).catch((err) => { console.error(err); process.exit(1); });
}
