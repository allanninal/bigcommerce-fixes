/**
 * Repair BigCommerce category images without resending image_file as JSON.
 *
 * BigCommerce's V3 Catalog Categories JSON endpoint (PUT /v3/catalog/categories)
 * only accepts image_url for setting or replacing a category's image. image_file
 * is a real field, but it belongs to the separate multipart/form-data endpoint,
 * POST /v3/catalog/categories/{category_id}/image, which needs
 * Content-Type: multipart/form-data, not JSON. A sync script that PUTs image_file
 * as JSON to the categories endpoint gets a 400, "the field 'image_file' is
 * invalid", because that resource's schema has no such property. This job lists
 * categories, compares each one's image_url against a source-of-truth image
 * source, and repairs it with the correct call for whatever source is available:
 * image_url as JSON when a public URL exists, or image_file as multipart when
 * only a local file exists. A category with neither is flagged for manual
 * review, never guessed at. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/category-image-file-rejected/
 */
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * category = { id, image_url } the current BigCommerce state.
 * imageSource = { public_url, local_file_path } what we have on file.
 *
 * If image_url is missing, or differs from an available public_url, repair
 * with put_image_url (JSON, image_url field). Otherwise, if only a local file
 * exists, repair with post_multipart_image (multipart, image_file field,
 * scoped to this category's id). If neither source is available, flag for a
 * human. This function must never return action="put_image_url" paired with
 * field="image_file", that pairing is exactly the 400-triggering bug.
 */
export function chooseImageRepairStrategy(category, imageSource) {
  const currentUrl = category.image_url;
  const publicUrl = imageSource.public_url;
  const localFilePath = imageSource.local_file_path;

  if (publicUrl && (!currentUrl || currentUrl !== publicUrl)) {
    return {
      action: "put_image_url",
      endpoint: "/v3/catalog/categories",
      field: "image_url",
      value: publicUrl,
    };
  }

  if (localFilePath) {
    return {
      action: "post_multipart_image",
      endpoint: `/v3/catalog/categories/${category.id}/image`,
      field: "image_file",
      value: localFilePath,
    };
  }

  return { action: "flag", reason: "no_image_source_available" };
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

async function bcPutJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function bcPostMultipart(path, filePath) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("image_file", new Blob([bytes]), basename(filePath));
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "X-Auth-Token": ACCESS_TOKEN, Accept: "application/json" },
    body: form,
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* allCategories() {
  let page = 1;
  while (true) {
    const result = await bcGet("/catalog/categories", { limit: 250, page });
    for (const category of result.data || []) yield category;
    const pagination = result.meta?.pagination || {};
    if (page >= (pagination.total_pages || page)) return;
    page += 1;
  }
}

async function applyRepair(categoryId, strategy) {
  if (strategy.action === "put_image_url") {
    return bcPutJson("/catalog/categories", [{ id: categoryId, image_url: strategy.value }]);
  }
  if (strategy.action === "post_multipart_image") {
    return bcPostMultipart(`/catalog/categories/${categoryId}/image`, strategy.value);
  }
  return null;
}

/** Placeholder for your source-of-truth lookup. Replace with a real
 * catalog/DB/CMS query that returns { public_url, local_file_path } for the
 * given categoryId, using null for whichever is not available. */
async function loadImageSource(categoryId) {
  return { public_url: null, local_file_path: null };
}

export async function run() {
  let repaired = 0;
  let flagged = 0;

  for await (const category of allCategories()) {
    const categoryId = category.id;
    const imageSource = await loadImageSource(categoryId);
    const strategy = chooseImageRepairStrategy(category, imageSource);

    if (strategy.action === "flag") {
      console.warn(`Category ${categoryId} flagged. reason=${strategy.reason} current_image_url=${category.image_url}`);
      flagged += 1;
      continue;
    }

    console.log(
      `category_id=${categoryId} action=${strategy.action} endpoint=${strategy.endpoint} ` +
      `field=${strategy.field} (${DRY_RUN ? "dry run" : "applying"})`
    );
    if (!DRY_RUN) await applyRepair(categoryId, strategy);
    repaired += 1;
  }

  console.log(
    `Done. ${repaired} categor${repaired === 1 ? "y" : "ies"} ${DRY_RUN ? "to repair" : "repaired"}, ` +
    `${flagged} categor${flagged === 1 ? "y" : "ies"} flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
