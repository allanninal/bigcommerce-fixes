/**
 * Requeue BigCommerce product images dropped by a batch-shaped import.
 *
 * BigCommerce's v3 Catalog API has no batch endpoint for product images.
 * POST /v3/catalog/products/{product_id}/images is scoped to create exactly
 * one image resource per call, a single image_file (multipart/form-data) or a
 * single image_url (application/json), unlike the batch endpoints that exist
 * for products (PUT /v3/catalog/products) and variants
 * (PUT /v3/catalog/products/{product_id}/variants). Import scripts written by
 * analogy to those batch endpoints, or to the nested images array returned by
 * GET .../products?include=images, assume the images endpoint also accepts an
 * array. BigCommerce either 422s on the unexpected shape or the client's
 * serializer only encodes the first element, so every image after the first
 * is dropped behind a response that still looks like success. This job reads
 * the persisted images for each product, diffs them against a source
 * manifest, and requeues only the images that are actually missing, one POST
 * per image. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/bulk-image-api-single-image-per-request/
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const SOURCE_MANIFEST_PATH = process.env.SOURCE_MANIFEST_PATH || "./import-manifest.json";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/** Reduce a source filename or a BigCommerce CDN URL to a comparable key. */
function normalizeKey(urlOrName) {
  if (!urlOrName) return "";
  let path = urlOrName;
  try {
    path = new URL(urlOrName).pathname;
  } catch {
    path = urlOrName;
  }
  const basename = path.split("/").filter(Boolean).pop() || path;
  return decodeURIComponent(basename).trim().toLowerCase();
}

/**
 * Pure function. No network, no side effects.
 *
 * sourceImages: ordered list of source image URLs/filenames for one product.
 * persistedImages: the `data` array from GET .../products/{id}/images, each
 * object with at least `image_url`, `id`, and `sort_order`.
 *
 * Returns the sublist of sourceImages whose normalized key (basename or
 * canonical URL) is not present among the persisted images' normalized keys,
 * preserving source order, so the caller knows exactly which images to
 * requeue and in what order.
 */
export function diffMissingImages(sourceImages, persistedImages) {
  const persistedKeys = new Set(
    (persistedImages || [])
      .map((img) => img.image_url)
      .filter(Boolean)
      .map(normalizeKey)
  );
  return (sourceImages || []).filter((src) => !persistedKeys.has(normalizeKey(src)));
}

export function nextSortOrder(persistedImages) {
  if (!persistedImages || !persistedImages.length) return 0;
  return Math.max(...persistedImages.map((img) => img.sort_order ?? 0)) + 1;
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

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function persistedImages(productId) {
  const images = [];
  let page = 1;
  while (true) {
    const resp = await bcGet(`/catalog/products/${productId}/images`, { page, limit: 250 });
    const batch = resp.data || [];
    if (!batch.length) return images;
    images.push(...batch);
    const pagination = resp.meta?.pagination || {};
    if (page >= (pagination.total_pages || page)) return images;
    page += 1;
  }
}

/** One image per call. The endpoint has no batch mode. */
async function uploadOneImage(productId, imageUrl, sortOrder) {
  return bcPost(`/catalog/products/${productId}/images`, {
    image_url: imageUrl,
    is_thumbnail: false,
    sort_order: sortOrder,
  });
}

/** Expected shape: {"products": [{"product_id": 123, "images": ["https://.../a.jpg", ...]}, ...]} */
function loadSourceManifest(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export async function run() {
  const manifest = loadSourceManifest(SOURCE_MANIFEST_PATH);
  let reconciled = 0;
  let requeuedTotal = 0;

  for (const product of manifest.products || []) {
    const productId = product.product_id;
    const sourceImages = product.images || [];
    if (!sourceImages.length) continue;

    const current = await persistedImages(productId);
    const missing = diffMissingImages(sourceImages, current);

    if (!missing.length) {
      reconciled += 1;
      continue;
    }

    let sortOrder = nextSortOrder(current);
    for (const imageUrl of missing) {
      console.log(
        `product_id=${productId} image_url=${imageUrl} sort_order=${sortOrder} ` +
        `(${DRY_RUN ? "dry run" : "uploading"})`
      );
      if (!DRY_RUN) await uploadOneImage(productId, imageUrl, sortOrder);
      sortOrder += 1;
      requeuedTotal += 1;
    }

    if (!DRY_RUN) {
      const after = await persistedImages(productId);
      const stillMissing = diffMissingImages(sourceImages, after);
      if (stillMissing.length) {
        console.warn(
          `product_id=${productId} still missing ${stillMissing.length} image(s) after requeue: ${stillMissing}`
        );
      } else {
        reconciled += 1;
        console.log(`product_id=${productId} reconciled, ${after.length} image(s) now persisted`);
      }
    }
  }

  console.log(
    `Done. ${requeuedTotal} image(s) ${DRY_RUN ? "to requeue" : "requeued"}, ${reconciled} product(s) reconciled.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
