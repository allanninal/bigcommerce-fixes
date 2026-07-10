/**
 * Find and safely repair BigCommerce customers stuck in the wrong customer group.
 *
 * BigCommerce's native storefront only supports one global default customer group
 * at registration. It has no built-in conditional logic to route a signup into a
 * different group by email domain, order history, or a form answer. Merchants get
 * that conditional assignment from a custom script, a webhook, or a third-party
 * app that reads signup or order data and writes customer_group_id after the fact,
 * and when that rule has a bug, stale criteria, or races the platform's own
 * default-group assignment, the customer is left in the wrong group and sees the
 * wrong price, since a Price List or discount rule resolves off customer_group_id.
 *
 * This lists customers, computes the expected group for each one from a rule you
 * define with a pure function, diffs it against the actual customer_group_id, and
 * reassigns the mismatched ones with a single PUT, re-reading the customer to
 * confirm the write persisted. It never touches order history, since BigCommerce
 * does not recompute a past order's price when the group changes. Guarded by
 * DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/customer-group-mis-assigned/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Define your own rule here. This example targets a wholesale group by email domain.
const REASSIGNMENT_RULE = {
  matchType: process.env.RULE_MATCH_TYPE || "email_domain",
  pattern: process.env.RULE_PATTERN || "wholesale-buyer.example",
  thresholdCents: Number(process.env.RULE_THRESHOLD_CENTS || 500000),
  targetGroupId: Number(process.env.RULE_TARGET_GROUP_ID || 3),
  fallbackGroupId: Number(process.env.RULE_FALLBACK_GROUP_ID || 0),
};

/**
 * Pure decision. No network calls.
 *
 * customer: { id, customer_group_id, email, tax_exempt_category?,
 *             total_lifetime_spend_cents?, registration_source? }
 * rule: { matchType, pattern?, thresholdCents?, targetGroupId, fallbackGroupId }
 *
 * Returns { customerId, currentGroupId, expectedGroupId, needsReassignment, reason }.
 */
export function decideGroupReassignment(customer, rule) {
  const { matchType, targetGroupId, fallbackGroupId } = rule;
  const currentGroupId = customer.customer_group_id;
  let expectedGroupId;
  let reason;

  if (matchType === "email_domain") {
    const domain = (customer.email || "").split("@").pop().toLowerCase();
    const pattern = (rule.pattern || "").toLowerCase();
    expectedGroupId = domain === pattern ? targetGroupId : fallbackGroupId;
    reason = domain === pattern
      ? `email domain "${domain}" matches "${rule.pattern}"`
      : `email domain "${domain}" does not match "${rule.pattern}"`;
  } else if (matchType === "spend_threshold") {
    const spend = customer.total_lifetime_spend_cents || 0;
    expectedGroupId = spend >= rule.thresholdCents ? targetGroupId : fallbackGroupId;
    reason = `lifetime spend ${spend} vs threshold ${rule.thresholdCents}`;
  } else if (matchType === "tax_exempt") {
    expectedGroupId = customer.tax_exempt_category ? targetGroupId : fallbackGroupId;
    reason = `tax_exempt_category=${customer.tax_exempt_category}`;
  } else if (matchType === "source_tag") {
    expectedGroupId = customer.registration_source === rule.pattern ? targetGroupId : fallbackGroupId;
    reason = `registration_source=${customer.registration_source} vs ${rule.pattern}`;
  } else {
    expectedGroupId = fallbackGroupId;
    reason = `unknown matchType "${matchType}", defaulting to fallback`;
  }

  const needsReassignment = expectedGroupId !== currentGroupId;
  reason = needsReassignment
    ? `${reason}; expected group ${expectedGroupId} but customer is in group ${currentGroupId}`
    : `${reason}; already in the correct group ${currentGroupId}`;

  return { customerId: customer.id, currentGroupId, expectedGroupId, needsReassignment, reason };
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

async function* allCustomers() {
  let page = 1;
  while (true) {
    const result = await bc("GET", `/v3/customers?limit=250&page=${page}`);
    if (!result || !result.length) return;
    for (const customer of result) yield customer;
    if (result.length < 250) return;
    page += 1;
  }
}

function groupName(groups, groupId) {
  const match = groups.find((g) => g.id === groupId);
  return match ? match.name : `group ${groupId}`;
}

async function reassignGroup(customerId, expectedGroupId) {
  const payload = [{ id: customerId, customer_group_id: expectedGroupId }];
  const result = await bc("PUT", "/v3/customers", payload);
  const updated = Array.isArray(result) ? result[0] : result;
  if (updated.customer_group_id !== expectedGroupId) {
    throw new Error(`customer ${customerId} did not update to group ${expectedGroupId}`);
  }
  const confirm = await bc("GET", `/v3/customers/${customerId}`);
  const confirmed = Array.isArray(confirm) ? confirm[0] : confirm;
  if (confirmed.customer_group_id !== expectedGroupId) {
    throw new Error(`customer ${customerId} group did not persist as ${expectedGroupId}`);
  }
  return confirmed;
}

export async function run() {
  let reassigned = 0;
  let checked = 0;
  const groups = await customerGroups();

  for await (const customer of allCustomers()) {
    checked++;
    const decision = decideGroupReassignment(customer, REASSIGNMENT_RULE);
    if (!decision.needsReassignment) continue;

    console.warn(
      `Customer ${decision.customerId}: ${groupName(groups, decision.currentGroupId)} -> ${groupName(groups, decision.expectedGroupId)} (${decision.reason}). ${DRY_RUN ? "would reassign" : "reassigning"}`
    );
    if (!DRY_RUN) await reassignGroup(decision.customerId, decision.expectedGroupId);
    reassigned++;
  }

  console.log(`Done. Checked ${checked} customer(s). ${reassigned} ${DRY_RUN ? "to reassign" : "reassigned"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
