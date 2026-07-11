/**
 * Clear legacy customer group discount_rules that are blocking a Price List.
 *
 * BigCommerce customer groups support two mutually exclusive pricing
 * mechanisms: legacy discount_rules (store-wide, category, or product
 * percent, fixed, or price-modifier discounts, set through the V2 Customer
 * Groups API) and V3 Price List assignments. A group can only run one at a
 * time. If discount_rules is still non-empty on a group from before Price
 * Lists were adopted, a Price List assignment created with POST
 * /v3/pricelists/assignments will not visibly apply at storefront for that
 * group, because the legacy discount takes precedence and the group's
 * pricing representation reverts to method/amount instead of price_list_id.
 * This job lists every customer group and every active price list
 * assignment, flags the groups where both a legacy discount and a price list
 * are configured at once, and clears the legacy discount_rules on those
 * groups only, leaving the price list assignment itself untouched.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/legacy-group-discount-blocks-price-list/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * customerGroups: V2 /v2/customer_groups records, each
 *   { id, name, discount_rules, ... }
 * priceListAssignments: V3 /v3/pricelists/assignments 'data' records, each
 *   { price_list_id, customer_group_id, channel_id }
 *
 * A group is 'blocked' if it has a non-empty legacy discount_rules list AND
 * it also appears as customer_group_id in at least one priceListAssignments
 * entry. Returns one object per blocked group: { group_id, group_name,
 * discount_rules, price_list_ids }.
 */
export function findBlockedPriceListGroups(customerGroups, priceListAssignments) {
  const assignedGroupIds = new Map();
  for (const a of priceListAssignments) {
    const list = assignedGroupIds.get(a.customer_group_id) || [];
    list.push(a.price_list_id);
    assignedGroupIds.set(a.customer_group_id, list);
  }

  const blocked = [];
  for (const g of customerGroups) {
    const rules = g.discount_rules || [];
    const gid = g.id;
    if (rules.length && assignedGroupIds.has(gid)) {
      blocked.push({
        group_id: gid,
        group_name: g.name,
        discount_rules: rules,
        price_list_ids: assignedGroupIds.get(gid),
      });
    }
  }
  return blocked;
}

async function bcGetV2(path, params = {}) {
  const url = new URL(`${API_BASE_V2}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcGetV3(path, params = {}) {
  const url = new URL(`${API_BASE_V3}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : { data: [], meta: {} };
}

async function bcPutV2(path, body) {
  const res = await fetch(`${API_BASE_V2}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function allCustomerGroups() {
  const groups = [];
  let page = 1;
  while (true) {
    const batch = await bcGetV2("/customer_groups", { page, limit: 250 });
    if (!batch.length) return groups;
    groups.push(...batch);
    page += 1;
  }
}

async function allPriceListAssignments() {
  const assignments = [];
  let page = 1;
  while (true) {
    const result = await bcGetV3("/pricelists/assignments", { page, limit: 250 });
    const data = result.data || [];
    if (!data.length) return assignments;
    assignments.push(...data);
    page += 1;
  }
}

async function clearDiscountRules(groupId) {
  return bcPutV2(`/customer_groups/${groupId}`, { discount_rules: [] });
}

async function confirmCleared(groupId) {
  const group = await bcGetV2(`/customer_groups/${groupId}`);
  const rules = group.discount_rules || [];
  return rules.length === 0;
}

export async function run() {
  const groups = await allCustomerGroups();
  const assignments = await allPriceListAssignments();
  const blocked = findBlockedPriceListGroups(groups, assignments);

  console.log(`Found ${blocked.length} group(s) with a legacy discount blocking a price list.`);

  let cleared = 0;
  for (const entry of blocked) {
    console.log(
      `group_id=${entry.group_id} group_name=${entry.group_name} discount_rules=${JSON.stringify(entry.discount_rules)} ` +
      `price_list_ids=${JSON.stringify(entry.price_list_ids)} (${DRY_RUN ? "dry run" : "clearing"})`
    );
    if (!DRY_RUN) {
      await clearDiscountRules(entry.group_id);
      const ok = await confirmCleared(entry.group_id);
      if (!ok) console.warn(`group_id=${entry.group_id} did not confirm empty discount_rules after PUT.`);
      cleared += 1;
    }
  }

  console.log(
    `Done. ${blocked.length} group(s) ${DRY_RUN ? "to clear" : `cleared (${cleared} confirmed attempted)`}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
