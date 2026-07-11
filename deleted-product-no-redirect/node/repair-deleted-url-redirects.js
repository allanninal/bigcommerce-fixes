/**
 * Find and repair dangling URLs left behind by deleted BigCommerce products and categories.
 *
 * BigCommerce only auto-generates a 301 redirect when a product's or category's
 * custom_url is changed while the record still exists, the storefront URL-rewrite
 * history feature. Deleting the record outright, through the admin UI or
 * DELETE /v3/catalog/products/{id} or /v3/catalog/categories/{id}, never gives
 * BigCommerce an old path and a new path to reconcile, so no redirect row is ever
 * written and the old URL 404s indefinitely. This job keeps a snapshot of live
 * product and category custom_url values, diffs the previous snapshot against the
 * ids that are still live to find what was deleted, checks each candidate path
 * against the existing redirects, and upserts a 301 only for the paths that are
 * both confirmed deleted and confirmed uncovered. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/deleted-product-no-redirect/
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const SITE_ID = Number(process.env.BIGCOMMERCE_SITE_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || "url_snapshot.json";
const FALLBACK_TARGET = { type: "url", url: "/" };

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * previousUrls: object mapping entity id (number or numeric string) to its
 * custom_url.url from the last snapshot. currentIds: Set<number> of ids that
 * are still live right now. existingRedirectPaths: Set<string> of from_path
 * values that already have a redirect. fallbackTarget: the "to" object to use
 * for any new redirect.
 *
 * For each (id, url) in previousUrls where id is missing from currentIds
 * (deleted) and url is not already in existingRedirectPaths (no redirect
 * yet), emit {from_path: url, to: fallbackTarget}. Ids still present are
 * skipped (not deleted). Urls already redirected are skipped (no-op, avoids
 * duplicate or conflicting redirects).
 */
export function planRedirects(previousUrls, currentIds, existingRedirectPaths, fallbackTarget) {
  const plan = [];
  for (const [entityId, url] of Object.entries(previousUrls)) {
    if (currentIds.has(Number(entityId))) continue;
    if (existingRedirectPaths.has(url)) continue;
    plan.push({ from_path: url, to: fallbackTarget });
  }
  return plan;
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
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function snapshotUrls(resource) {
  const urls = {};
  let page = 1;
  while (true) {
    const res = await bcGet(`/catalog/${resource}`, {
      include_fields: "custom_url,id",
      page,
      limit: 250,
    });
    for (const item of res.data || []) {
      const url = item.custom_url && item.custom_url.url;
      if (url) urls[item.id] = url;
    }
    const pagination = (res.meta && res.meta.pagination) || {};
    if (page >= (pagination.total_pages || page)) return urls;
    page += 1;
  }
}

async function existingRedirectPaths(candidatePaths) {
  if (!candidatePaths.length) return new Set();
  const res = await bcGet("/storefront/redirects", { "path:in": candidatePaths.join(",") });
  return new Set((res.data || []).map((row) => row.from_path));
}

async function upsertRedirects(plan) {
  const body = plan.map((item) => ({ from_path: item.from_path, site_id: SITE_ID, to: item.to }));
  return bcPut("/storefront/redirects", body);
}

async function loadPreviousSnapshot() {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSnapshot(urls) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(urls));
}

export async function run() {
  const previousUrls = await loadPreviousSnapshot();

  const currentProducts = await snapshotUrls("products");
  const currentCategories = await snapshotUrls("categories");
  const currentUrls = { ...currentProducts, ...currentCategories };
  const currentIds = new Set(Object.keys(currentUrls).map(Number));

  const candidatePaths = Object.entries(previousUrls)
    .filter(([entityId]) => !currentIds.has(Number(entityId)))
    .map(([, url]) => url);
  const covered = await existingRedirectPaths(candidatePaths);

  const plan = planRedirects(previousUrls, currentIds, covered, FALLBACK_TARGET);

  for (const item of plan) {
    console.log(`from_path=${item.from_path} to=${JSON.stringify(item.to)} (${DRY_RUN ? "dry run" : "upserting"})`);
  }

  if (plan.length && !DRY_RUN) {
    await upsertRedirects(plan);
    const confirmed = await existingRedirectPaths(plan.map((item) => item.from_path));
    for (const item of plan) {
      if (!confirmed.has(item.from_path)) {
        console.warn(`Redirect for ${item.from_path} did not confirm after upsert.`);
      }
    }
  }

  await saveSnapshot(currentUrls);

  console.log(`Done. ${plan.length} dangling path(s) ${DRY_RUN ? "found (dry run)" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
