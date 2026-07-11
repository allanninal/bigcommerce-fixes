/**
 * Find BigCommerce promotions where group_ids and excluded_group_ids both fire.
 *
 * A promotion's customer eligibility object can carry both group_ids (an allow-list
 * of customer group IDs) and excluded_group_ids (a deny-list). The Promotions API
 * accepts and stores this combination without a validation error, because it only
 * checks the shape of the request, not the business logic of the rule. BigCommerce's
 * own docs say only one of the two fields should be populated at a time. When both
 * are non-empty, the promotion engine's eligibility check has no defined precedence
 * between "must be in these groups" and "must not be in these groups," so it fails
 * closed and the promotion never triggers at checkout for any shopper, even ones who
 * satisfy group_ids. This job lists every ENABLED promotion, flags the ones with a
 * conflicting allow-list and deny-list at the top level or inside any rule, and only
 * ever reports the conflict with a suggested fix, unless explicitly told to apply the
 * opt-in clear-excluded-group-ids remediation.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/promotion-group-exclusion-conflict/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const APPLY_CLEAR_EXCLUDED = process.argv.includes("--apply-clear-excluded");

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Both empty, or only one of the two lists populated: no conflict (a valid,
 * unambiguous eligibility rule, including the valid all-customers case).
 * Both non-empty, including the group_id 0 guest sentinel appearing in either
 * list: conflict, with a default suggested fix of clearing excluded_group_ids
 * to keep the narrower, more deliberate allow-list.
 */
export function decideGroupConflict(groupIds, excludedGroupIds) {
  const hasGroupIds = (groupIds || []).length > 0;
  const hasExcludedGroupIds = (excludedGroupIds || []).length > 0;

  if (hasGroupIds && hasExcludedGroupIds) {
    return {
      conflict: true,
      reason: "both group_ids and excluded_group_ids populated",
      suggestedFix: { clear: "excluded_group_ids" },
    };
  }
  return {
    conflict: false,
    reason: "at most one of the two lists is populated",
    suggestedFix: null,
  };
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

async function* enabledPromotions() {
  let params = { status: "ENABLED", limit: 250 };
  let path = "/promotions";
  while (path) {
    const payload = await bcGet(path, params || {});
    for (const promo of payload.data || []) yield promo;
    const nextUrl =
      payload.meta && payload.meta.pagination && payload.meta.pagination.links && payload.meta.pagination.links.next;
    path = nextUrl ? nextUrl.replace(API_BASE, "") : null;
    params = null;
  }
}

function* eligibilityPairs(promotion) {
  const customer = promotion.customer || {};
  yield ["top_level", customer.group_ids || [], customer.excluded_group_ids || []];
  const rules = promotion.rules || [];
  for (let i = 0; i < rules.length; i++) {
    const ruleCustomer = rules[i].customer || {};
    if (rules[i].customer) {
      yield [`rules[${i}]`, ruleCustomer.group_ids || [], ruleCustomer.excluded_group_ids || []];
    }
  }
}

async function applyClearExcluded(promotion) {
  const promoId = promotion.id;
  const customer = { ...(promotion.customer || {}) };
  customer.excluded_group_ids = [];
  await bcPut(`/promotions/${promoId}`, { customer });

  const refreshed = await bcGet(`/promotions/${promoId}`);
  const data = refreshed.data || refreshed;
  const fixedCustomer = data.customer || {};
  const stillConflicting = decideGroupConflict(
    fixedCustomer.group_ids || [],
    fixedCustomer.excluded_group_ids || []
  ).conflict;
  return !stillConflicting;
}

export async function run() {
  let flagged = 0;
  let resolved = 0;

  for await (const promo of enabledPromotions()) {
    for (const [scope, groupIds, excludedGroupIds] of eligibilityPairs(promo)) {
      const result = decideGroupConflict(groupIds, excludedGroupIds);
      if (!result.conflict) continue;

      flagged += 1;
      console.warn(
        `CONFLICT id=${promo.id} name=${JSON.stringify(promo.name)} scope=${scope} ` +
        `group_ids=${JSON.stringify(groupIds)} excluded_group_ids=${JSON.stringify(excludedGroupIds)} ` +
        `suggested_fix=${JSON.stringify(result.suggestedFix)}`
      );

      if (scope === "top_level" && !DRY_RUN && APPLY_CLEAR_EXCLUDED) {
        const ok = await applyClearExcluded(promo);
        if (ok) {
          resolved += 1;
          console.log(`RESOLVED id=${promo.id} cleared excluded_group_ids`);
        } else {
          console.error(`STILL CONFLICTING id=${promo.id} after apply, needs manual review`);
        }
      }
    }
  }

  console.log(`Done. ${flagged} conflict(s) flagged, ${resolved} resolved.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
