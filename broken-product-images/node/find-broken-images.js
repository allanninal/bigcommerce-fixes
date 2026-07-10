/**
 * Find and repair broken BigCommerce product images.
 *
 * A product image record on /v3/catalog/products/{product_id}/images stores
 * metadata and derived CDN URLs (url_zoom, url_standard, url_thumbnail, url_tiny)
 * that point at a file BigCommerce's image service is expected to serve, but the
 * underlying file can go missing while the database row survives. This commonly
 * follows a bulk CSV/V2 import that set image_url to a URL that was never truly
 * fetched, a WMS/PIM sync that wrote a row referencing a file deleted or renamed
 * before BigCommerce could pull it, or a botched Stencil/CDN migration or app
 * cleanup that purges files without deleting the matching image records.
 *
 * This pages through GET /v3/catalog/products?include=images&limit=250 across
 * the full catalog, checks the status of every image URL, classifies each image
 * with a pure decision function, and in write mode clears a confirmed-dead
 * reference (self-healing with a replacement URL if one is known, otherwise
 * deleting the row) and promotes the next image to thumbnail if the one removed
 * was the product's thumbnail. It never deletes on sight. Guarded by DRY_RUN.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/broken-product-images/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "dummy_store_hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Optional map of broken image_url -> known-good replacement URL, comma-separated
// pairs "old=>new". Left empty by default so broken images with no confirmed
// replacement fall back to a logged delete instead of a guess.
const REPLACEMENT_URLS = {};
for (const pair of (process.env.REPLACEMENT_URLS || "").split(",")) {
  const idx = pair.indexOf("=>");
  if (idx === -1) continue;
  const oldUrl = pair.slice(0, idx).trim();
  const newUrl = pair.slice(idx + 2).trim();
  if (oldUrl && newUrl) REPLACEMENT_URLS[oldUrl] = newUrl;
}

const URL_RE = /^https?:\/\//i;

function isMalformed(url) {
  return typeof url !== "string" || !url.trim() || !URL_RE.test(url.trim());
}

/**
 * Pure decision. No network calls, no side effects.
 *
 * image: { id, image_url, url_standard, is_thumbnail, sort_order }
 * urlStatus: mapping of URL -> HTTP status code (or null if unreachable),
 *            obtained by the caller beforehand.
 * remainingImages: sibling images still on the product.
 *
 * Returns "ok", "flag_only", "clear_reference", or "promote_thumbnail".
 */
export function decideImageAction(image, urlStatus, remainingImages) {
  const url = image.url_standard || image.image_url;

  if (isMalformed(url)) return "flag_only";

  const status = urlStatus[url];
  if (status !== undefined && status !== null && status >= 200 && status < 300) return "ok";

  if (status !== 403 && status !== 404) return "flag_only";

  const siblings = remainingImages.filter((i) => i.id !== image.id);
  if (siblings.length === 0) return "flag_only";

  const hasGoodSibling = siblings.some((s) => {
    const sUrl = s.url_standard || s.image_url;
    if (isMalformed(sUrl)) return false;
    const sStatus = urlStatus[sUrl];
    return sStatus === undefined || sStatus === null || (sStatus !== 403 && sStatus !== 404);
  });

  if (image.is_thumbnail && hasGoodSibling) return "promote_thumbnail";

  return "clear_reference";
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
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

/** I/O helper: HEAD (falling back to GET) a URL and return its status code,
 * or null if the request could not complete at all. */
async function checkUrlStatus(url) {
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (res.status === 405) res = await fetch(url, { method: "GET", redirect: "follow" });
    return res.status;
  } catch {
    return null;
  }
}

async function* allProducts() {
  const limit = 250;
  let page = 1;
  while (true) {
    const batch = await bc("GET", `/v3/catalog/products?include=images&limit=${limit}&page=${page}`);
    if (!batch || !batch.length) return;
    for (const product of batch) yield product;
    if (batch.length < limit) return;
    page += 1;
  }
}

async function clearReference(productId, imageId, replacementUrl) {
  if (replacementUrl) {
    return bc("PUT", `/v3/catalog/products/${productId}/images/${imageId}`, { image_url: replacementUrl });
  }
  return bc("DELETE", `/v3/catalog/products/${productId}/images/${imageId}`);
}

async function promoteThumbnail(productId, remainingImages, brokenImageId) {
  const candidates = remainingImages
    .filter((i) => i.id !== brokenImageId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (candidates.length === 0) return null;
  const nextImage = candidates[0];
  return bc("PUT", `/v3/catalog/products/${productId}/images/${nextImage.id}`, { is_thumbnail: true });
}

export async function run() {
  let flagged = 0;
  let cleared = 0;
  let promoted = 0;

  for await (const product of allProducts()) {
    const images = product.images || [];
    const urlStatus = {};
    for (const image of images) {
      const url = image.url_standard || image.image_url;
      if (url && !isMalformed(url)) {
        urlStatus[url] = await checkUrlStatus(url);
      }
    }

    for (const image of images) {
      const action = decideImageAction(image, urlStatus, images);
      if (action === "ok") continue;

      const url = image.url_standard || image.image_url;
      console.warn(
        `product=${product.id} image=${image.id} sort_order=${image.sort_order} action=${action} url=${JSON.stringify(url)} before=${JSON.stringify(image)}`
      );
      flagged++;

      if (DRY_RUN) continue;

      if (action === "clear_reference") {
        const replacement = REPLACEMENT_URLS[url];
        await clearReference(product.id, image.id, replacement);
        cleared++;
      } else if (action === "promote_thumbnail") {
        const replacement = REPLACEMENT_URLS[url];
        await clearReference(product.id, image.id, replacement);
        await promoteThumbnail(product.id, images, image.id);
        cleared++;
        promoted++;
      }
    }
  }

  console.log(
    `Done. ${flagged} image(s) flagged, ${cleared} cleared, ${promoted} thumbnail(s) promoted. (${DRY_RUN ? "dry run" : "write mode"})`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
