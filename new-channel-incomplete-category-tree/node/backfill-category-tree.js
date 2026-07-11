/**
 * Backfill a new BigCommerce storefront channel's incomplete category tree.
 *
 * In BigCommerce's Multi-Storefront architecture, a category tree (a
 * /v3/catalog/trees object) is a standalone resource assigned to at most one
 * channel at a time. Creating a new storefront channel does not clone the
 * primary storefront's tree, so the new channel starts unassigned or
 * pointed at a fresh, empty tree. Because category-to-tree membership is
 * explicit (categories belong to a specific tree_id, not automatically to
 * all channels), any node created after the second channel was provisioned,
 * or never manually copied, produces a permanent structural gap between the
 * two storefronts' navigation.
 *
 * This job resolves the primary and secondary channel's tree_id, pulls the
 * full category node set for both trees, diffs them by a stable name-and-
 * parent-path key with a pure function, and backfills only the missing
 * nodes into the secondary tree, parent-first. Never modifies the primary
 * tree. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/new-channel-incomplete-category-tree/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const PRIMARY_CHANNEL_ID = process.env.PRIMARY_CHANNEL_ID || "1";
const SECONDARY_CHANNEL_ID = process.env.SECONDARY_CHANNEL_ID || "2";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MAX_BATCH = 200;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure. No network, no side effects.
 *
 * Builds a path (join of ancestor names) for every node in both trees using
 * parent_id chains, builds a set of secondary paths, then returns every
 * primary node whose path is not in the secondary set, sorted by depth
 * ascending so parent nodes are listed before their children.
 */
function buildPaths(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  function pathFor(node) {
    const chain = [];
    let current = node;
    const seen = new Set();
    while (current) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      chain.push(current.name);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return chain.reverse();
  }

  const paths = new Map();
  for (const n of nodes) paths.set(n.id, pathFor(n));
  return paths;
}

export function diffCategoryTrees(primaryNodes, secondaryNodes) {
  const primaryPaths = buildPaths(primaryNodes);
  const secondaryPaths = buildPaths(secondaryNodes);
  const secondarySet = new Set([...secondaryPaths.values()].map((p) => p.join("/")));

  const missing = [];
  for (const node of primaryNodes) {
    const path = primaryPaths.get(node.id);
    if (secondarySet.has(path.join("/"))) continue;
    missing.push({ path, name: node.name, parent_path: path.slice(0, -1) });
  }

  missing.sort((a, b) => a.path.length - b.path.length);
  return { missing };
}

async function bcGetAll(path, params = {}) {
  const items = [];
  let page = 1;
  while (true) {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries({ limit: 250, ...params, page })) {
      url.searchParams.set(key, value);
    }
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
    const body = await res.json();
    items.push(...(body.data || []));
    const next = body.meta?.pagination?.links?.next;
    if (!next) return items;
    page += 1;
  }
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

async function treeIdForChannel(channelId) {
  const trees = await bcGetAll("/catalog/trees", { "channel_id:in": channelId });
  if (!trees.length) return null;
  return trees[0].id;
}

async function treeCategories(treeId) {
  return bcGetAll(`/catalog/trees/${treeId}/categories`);
}

async function backfillBatch(treeId, categories) {
  const payload = categories.map((c) => ({ ...c, tree_id: treeId }));
  return bcPost("/catalog/trees/categories", payload.slice(0, MAX_BATCH));
}

export async function run() {
  const primaryTreeId = await treeIdForChannel(PRIMARY_CHANNEL_ID);
  const secondaryTreeId = await treeIdForChannel(SECONDARY_CHANNEL_ID);

  if (primaryTreeId == null || secondaryTreeId == null) {
    console.warn(
      `Could not resolve tree ids. primary_channel=${PRIMARY_CHANNEL_ID} -> ${primaryTreeId}, ` +
      `secondary_channel=${SECONDARY_CHANNEL_ID} -> ${secondaryTreeId}`
    );
    return;
  }

  const primaryNodes = await treeCategories(primaryTreeId);
  const secondaryNodes = await treeCategories(secondaryTreeId);

  const { missing } = diffCategoryTrees(primaryNodes, secondaryNodes);

  if (!missing.length) {
    console.log(`No gap. Secondary tree ${secondaryTreeId} already matches primary tree ${primaryTreeId}.`);
    return;
  }

  const nameToNewId = new Map();
  for (const m of missing) {
    const parentPath = m.parent_path.join("/");
    const parentId = parentPath ? nameToNewId.get(parentPath) : null;

    console.log(
      `${DRY_RUN ? "PLAN" : "CREATE"} source_tree=${primaryTreeId} target_tree=${secondaryTreeId} ` +
      `path=${m.path.join("/")} resolved_parent_id=${parentId ?? null}`
    );

    if (!DRY_RUN) {
      const created = await backfillBatch(secondaryTreeId, [{ name: m.name, parent_id: parentId || 0 }]);
      const newId = created.data?.[0]?.id;
      nameToNewId.set(m.path.join("/"), newId);
    } else {
      nameToNewId.set(m.path.join("/"), `<new:${m.path.join("/")}>`);
    }
  }

  console.log(`Done. ${missing.length} node(s) ${DRY_RUN ? "planned" : "created"} in secondary tree ${secondaryTreeId}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
