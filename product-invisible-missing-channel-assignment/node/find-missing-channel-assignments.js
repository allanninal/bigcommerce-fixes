/**
 * Find BigCommerce products that are visible and categorized but missing
 * from a channel's assignment set.
 *
 * Category membership and the product's is_visible flag only control whether
 * a product can appear within a category tree or search index. They say
 * nothing about which sales channel exposes the product at all. A product is
 * only reachable on a given channel if it has an explicit row in the
 * products-channel-assignments table, created with a PUT to
 * /v3/catalog/products/channel-assignments. New storefronts and channels do
 * not automatically inherit assignments from the default channel, and bulk
 * imports, CSV product uploads, and the default Channel Manager flow can
 * silently skip a newly created channel. This job lists every channel, every
 * visible catalog product, and every channel's assigned product ids, then
 * reports every (product_id, channel_id) gap. It is not safe to auto-fix
 * blindly, a missing assignment can be intentional for a channel-specific
 * catalog, so by default this only reports. Pass --repair-channel=<channel_id>
 * to write assignments for that one channel, guarded by DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/product-invisible-missing-channel-assignment/
 */
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPORT_PATH = process.env.REPORT_PATH || "channel_assignment_gaps.csv";

const BATCH_SIZE = 50;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure set-difference logic. No network, no side effects.
 *
 * catalogProductIds: iterable of the full set of catalog product ids.
 * channelAssignments: object keyed by channel_id -> Set of product ids
 * assigned to that channel, from /v3/catalog/products/channel-assignments.
 * visibleIds: Set of the subset of catalogProductIds where is_visible is true.
 *
 * Returns a sorted list of [product_id, channel_id] pairs for every visible
 * product missing from every known channel's assignment set.
 */
export function findMissingChannelAssignments(catalogProductIds, channelAssignments, visibleIds) {
  const gaps = [];
  for (const [channelIdStr, assignedIds] of Object.entries(channelAssignments)) {
    const channelId = Number(channelIdStr);
    for (const productId of catalogProductIds) {
      if (visibleIds.has(productId) && !assignedIds.has(productId)) {
        gaps.push([productId, channelId]);
      }
    }
  }
  gaps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return gaps;
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

async function* allChannels() {
  let page = 1;
  while (true) {
    const res = await bcGet("/channels", { page, limit: 250 });
    const data = res.data || [];
    if (!data.length) return;
    for (const channel of data) yield channel;
    const totalPages = res.meta?.pagination?.total_pages || page;
    if (page >= totalPages) return;
    page += 1;
  }
}

async function visibleCatalogProductIds() {
  const allIds = new Set();
  const visibleIds = new Set();
  let page = 1;
  while (true) {
    const res = await bcGet("/catalog/products", {
      limit: 250, page, include_fields: "id,name,is_visible",
    });
    const data = res.data || [];
    if (!data.length) break;
    for (const product of data) {
      allIds.add(product.id);
      if (product.is_visible) visibleIds.add(product.id);
    }
    const totalPages = res.meta?.pagination?.total_pages || page;
    if (page >= totalPages) break;
    page += 1;
  }
  return { allIds, visibleIds };
}

async function channelAssignedProductIds(channelId) {
  const ids = new Set();
  let page = 1;
  while (true) {
    const res = await bcGet("/catalog/products/channel-assignments", {
      "channel_id:in": channelId, limit: 250, page,
    });
    const data = res.data || [];
    if (!data.length) break;
    for (const row of data) ids.add(row.product_id);
    const totalPages = res.meta?.pagination?.total_pages || page;
    if (page >= totalPages) break;
    page += 1;
  }
  return ids;
}

// gapsForChannel: array of product_id. Never call this in parallel for the
// same product_id, per BigCommerce's own guidance against overlapping
// channel-assignment requests.
async function repairChannelGaps(gapsForChannel, channelId) {
  for (let i = 0; i < gapsForChannel.length; i += BATCH_SIZE) {
    const batch = gapsForChannel.slice(i, i + BATCH_SIZE);
    const body = batch.map((pid) => ({ product_id: pid, channel_id: channelId }));
    console.log(
      `${DRY_RUN ? "DRY RUN" : "WRITING"} PUT channel-assignments channel_id=${channelId} product_ids=${JSON.stringify(batch)}`
    );
    if (!DRY_RUN) await bcPut("/catalog/products/channel-assignments", body);
  }
}

export async function run() {
  const repairArg = process.argv.find((a) => a.startsWith("--repair-channel="));
  const repairChannelId = repairArg ? Number(repairArg.split("=")[1]) : null;

  const channels = [];
  for await (const channel of allChannels()) channels.push(channel);
  console.log(`Found ${channels.length} channel(s).`);

  const { allIds: catalogIds, visibleIds } = await visibleCatalogProductIds();
  console.log(`Found ${catalogIds.size} catalog product(s), ${visibleIds.size} visible.`);

  const channelAssignments = {};
  for (const channel of channels) {
    channelAssignments[channel.id] = await channelAssignedProductIds(channel.id);
    console.log(`Channel ${channel.id} (${channel.type}): ${channelAssignments[channel.id].size} assigned product(s).`);
  }

  const gaps = findMissingChannelAssignments(catalogIds, channelAssignments, visibleIds);

  const csv = ["product_id,channel_id", ...gaps.map(([p, c]) => `${p},${c}`)].join("\n");
  await writeFile(REPORT_PATH, csv, "utf8");
  console.log(`Wrote ${gaps.length} gap(s) to ${REPORT_PATH}`);
  console.log(JSON.stringify(gaps.slice(0, 20).map(([p, c]) => ({ product_id: p, channel_id: c }))));

  if (repairChannelId !== null) {
    const gapsForChannel = gaps.filter(([, c]) => c === repairChannelId).map(([p]) => p);
    console.log(`${DRY_RUN ? "Would repair" : "Repairing"} ${gapsForChannel.length} product(s) for channel_id=${repairChannelId}`);
    await repairChannelGaps(gapsForChannel, repairChannelId);
  }

  console.log(`Done. ${gaps.length} total gap(s) across ${channels.length} channel(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
