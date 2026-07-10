/**
 * Find and safely repair BigCommerce customer groups whose price list is not applied.
 *
 * A Price List by itself is only a container of custom prices. It has no effect on a
 * customer group until a Price List Assignment row links price_list_id and
 * customer_group_id, and optionally channel_id, through the V3 Price Lists
 * Assignments API. Building prices through a CSV import, migrating off the legacy
 * v2 group discount model, or adding a new sales channel commonly leaves that row
 * missing or scoped to the wrong channel, and the group silently falls back to
 * default catalog pricing with no error surfaced anywhere.
 *
 * This checks every customer group that has active customers, resolves the price
 * list, and decides with a pure function whether to create a missing assignment,
 * fix one scoped to a channel the group's customers do not use, or flag the price
 * list when it is correctly assigned but missing records for the variants being
 * bought. Guarded by DRY_RUN. Never writes a price. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/price-list-not-applied-to-a-group/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision. No network calls.
 *
 * group: { id, name }
 * priceList: { id, active } | null
 * assignments: [{ id, price_list_id, customer_group_id, channel_id }]
 * activeChannelIds: [number]
 * variantIdsNeedingPrice: [number]
 * existingRecordVariantIds: [number]
 *
 * Returns one of:
 *   { action: "NONE" }
 *   { action: "CREATE_ASSIGNMENT", priceListId, customerGroupId, channelId }
 *   { action: "FIX_CHANNEL", assignmentId, fromChannelId, toChannelId }
 *   { action: "FLAG_MISSING_RECORDS", priceListId, missingVariantIds }
 */
export function decideReassignment(
  group, priceList, assignments, activeChannelIds,
  variantIdsNeedingPrice, existingRecordVariantIds
) {
  if (!priceList || !priceList.active) return { action: "NONE" };

  const groupAssignments = assignments.filter(
    (a) => a.price_list_id === priceList.id && a.customer_group_id === group.id
  );

  if (groupAssignments.length === 0) {
    const channelId = activeChannelIds[0];
    return { action: "CREATE_ASSIGNMENT", priceListId: priceList.id, customerGroupId: group.id, channelId };
  }

  const mismatched = groupAssignments.find((a) => !activeChannelIds.includes(a.channel_id));
  if (mismatched) {
    return {
      action: "FIX_CHANNEL",
      assignmentId: mismatched.id,
      fromChannelId: mismatched.channel_id,
      toChannelId: activeChannelIds[0],
    };
  }

  const missing = variantIdsNeedingPrice.filter((v) => !existingRecordVariantIds.includes(v));
  if (missing.length > 0) {
    return { action: "FLAG_MISSING_RECORDS", priceListId: priceList.id, missingVariantIds: missing };
  }

  return { action: "NONE" };
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

async function customerGroups() {
  return (await bc("GET", "/v2/customer_groups")) || [];
}

async function groupsWithCustomers(groupIds) {
  const ids = groupIds.join(",");
  const counts = {};
  let page = 1;
  while (true) {
    const result = await bc("GET", `/v3/customers?customer_group_id=in:${ids}&limit=250&page=${page}`);
    if (!result || !result.length) return counts;
    for (const customer of result) {
      const gid = customer.customer_group_id;
      counts[gid] = (counts[gid] || 0) + 1;
    }
    if (result.length < 250) return counts;
    page += 1;
  }
}

async function priceLists() {
  return (await bc("GET", "/v3/pricelists?limit=250")) || [];
}

async function priceListAssignments(customerGroupId) {
  return (await bc("GET", `/v3/pricelists/assignments?customer_group_id=${customerGroupId}`)) || [];
}

async function priceListRecords(priceListId) {
  return (await bc("GET", `/v3/pricelists/${priceListId}/records?limit=250`)) || [];
}

async function activeChannelIds() {
  const channels = (await bc("GET", "/v3/channels?available=true")) || [];
  return channels.map((c) => c.id);
}

async function createAssignment(priceListId, customerGroupId, channelId) {
  const payload = [{ price_list_id: priceListId, customer_group_id: customerGroupId, channel_id: channelId }];
  return bc("POST", "/v3/pricelists/assignments", payload);
}

async function deleteAssignment(priceListId, customerGroupId, channelId) {
  const path =
    `/v3/pricelists/assignments?price_list_id=${priceListId}` +
    `&customer_group_id=${customerGroupId}&channel_id=${channelId}`;
  return bc("DELETE", path);
}

export async function run() {
  let created = 0;
  let fixed = 0;
  let flagged = 0;

  const groups = await customerGroups();
  const groupIds = groups.map((g) => g.id);
  const activeCounts = groupIds.length ? await groupsWithCustomers(groupIds) : {};
  const lists = await priceLists();
  const channelIds = await activeChannelIds();

  for (const group of groups) {
    if (!activeCounts[group.id]) continue;

    const priceList = lists.find((pl) => pl.active) || null;
    const assignments = await priceListAssignments(group.id);
    const variantIdsNeedingPrice = [];
    let existingRecordVariantIds = [];
    if (priceList) {
      const records = await priceListRecords(priceList.id);
      existingRecordVariantIds = records.map((r) => r.variant_id);
    }

    const decision = decideReassignment(
      group, priceList, assignments, channelIds,
      variantIdsNeedingPrice, existingRecordVariantIds
    );

    if (decision.action === "NONE") continue;

    if (decision.action === "CREATE_ASSIGNMENT") {
      console.log(
        `Group ${group.name} missing assignment to price list ${decision.priceListId}. ${DRY_RUN ? "would create" : "creating"}`
      );
      if (!DRY_RUN) await createAssignment(decision.priceListId, decision.customerGroupId, decision.channelId);
      created++;
    } else if (decision.action === "FIX_CHANNEL") {
      console.warn(
        `Group ${group.name} assignment ${decision.assignmentId} scoped to channel ${decision.fromChannelId}, not an active channel. ${DRY_RUN ? "would fix" : "fixing"}`
      );
      if (!DRY_RUN) {
        await deleteAssignment(priceList.id, group.id, decision.fromChannelId);
        await createAssignment(priceList.id, group.id, decision.toChannelId);
      }
      fixed++;
    } else if (decision.action === "FLAG_MISSING_RECORDS") {
      console.warn(
        `Price list ${decision.priceListId} assigned to group ${group.name} but missing records for variants ${decision.missingVariantIds}. Flagging for review.`
      );
      flagged++;
    }
  }

  console.log(
    `Done. ${created} assignment(s) ${DRY_RUN ? "to create" : "created"}, ${fixed} channel fix(es) ${DRY_RUN ? "to apply" : "applied"}, ${flagged} price list(s) flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
