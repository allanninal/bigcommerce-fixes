/**
 * Find BigCommerce coupon codes silently gated by their parent promotion's cap.
 *
 * In the Promotions v3 model, a coupon code is a child resource nested under a
 * parent Promotion (/v3/promotions/{promotionId}/codes/{codeId}), and both levels
 * carry independent max_uses/current_uses counters. BigCommerce enforces both at
 * checkout, and the promotion-level cap is the outer gate: even if a code's own
 * max_uses has plenty of headroom, the shopper gets "invalid coupon code" once the
 * parent promotion's aggregate current_uses reaches its max_uses. This job lists
 * every ENABLED promotion, pages its coupon codes, and flags any code where the
 * promotion is already exhausted or where the code's own remaining uses exceed
 * what the promotion has left. It never writes to a promotion's cap by default.
 * Raising a merchant's deliberate cap is a business decision, so a write only
 * happens behind an explicit --apply flag with DRY_RUN=false, and it always
 * prints the proposed diff first.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/parent-promotion-caps-override-coupon/
 */
import { pathToFileURL } from "node:url";

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
 * promotion={id,max_uses,current_uses,status}
 * codes=[{id,code,max_uses,current_uses}]
 *
 * promoRemaining = null if promotion.max_uses === 0 else
 *   max(promotion.max_uses - promotion.current_uses, 0)
 * codeRemaining = null if code.max_uses === 0 else
 *   max(code.max_uses - code.current_uses, 0)
 *
 * reason is "promotion_exhausted" if promoRemaining === 0,
 * "promotion_cap_lower_than_code" if promoRemaining !== null and
 *   (codeRemaining === null or codeRemaining > promoRemaining),
 * otherwise "ok".
 */
export function findCappedOutCodes(promotion, codes) {
  const promoMax = promotion.max_uses || 0;
  const promoCurrent = promotion.current_uses || 0;
  const promoRemaining = promoMax === 0 ? null : Math.max(promoMax - promoCurrent, 0);

  return codes.map((code) => {
    const codeMax = code.max_uses || 0;
    const codeCurrent = code.current_uses || 0;
    const codeRemaining = codeMax === 0 ? null : Math.max(codeMax - codeCurrent, 0);

    let reason;
    if (promoRemaining === 0) {
      reason = "promotion_exhausted";
    } else if (
      promoRemaining !== null &&
      (codeRemaining === null || codeRemaining > promoRemaining)
    ) {
      reason = "promotion_cap_lower_than_code";
    } else {
      reason = "ok";
    }

    return {
      code_id: code.id,
      code: code.code,
      reason,
      promotion_remaining: promoRemaining,
      code_remaining: codeRemaining,
    };
  });
}

async function bcGetPage(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const body = await res.json();
  return [body.data || [], (body.meta || {}).pagination || {}];
}

async function bcGetAll(path, params = {}) {
  let page = 1;
  const items = [];
  while (true) {
    const [data, pagination] = await bcGetPage(path, { ...params, page, limit: 250 });
    items.push(...data);
    const totalPages = pagination.total_pages || 1;
    if (page >= totalPages) return items;
    page += 1;
  }
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

async function enabledCouponPromotions() {
  const promotions = await bcGetAll("/promotions", { status: "ENABLED" });
  return promotions.filter((p) => (p.redemption_type || "").includes("COUPON"));
}

async function promotionCodes(promotionId) {
  return bcGetAll(`/promotions/${promotionId}/codes`);
}

function proposeRaisedCap(promotion, targetMaxUses) {
  return {
    promotion_id: promotion.id,
    from_max_uses: promotion.max_uses || 0,
    to_max_uses: targetMaxUses,
  };
}

async function applyRaisedCap(promotionId, targetMaxUses) {
  return bcPut(`/promotions/${promotionId}`, { max_uses: targetMaxUses });
}

export async function run(applyFix = false) {
  let flagged = 0;
  let checked = 0;

  for (const promotion of await enabledCouponPromotions()) {
    const codes = await promotionCodes(promotion.id);
    const annotated = findCappedOutCodes(promotion, codes);
    checked += annotated.length;

    const problemCodes = annotated.filter((c) => c.reason !== "ok");
    if (!problemCodes.length) continue;

    const maxCodeMaxUses = codes.length ? Math.max(...codes.map((c) => c.max_uses || 0)) : 0;
    const targetMaxUses = Math.max(maxCodeMaxUses, promotion.max_uses || 0);

    for (const c of problemCodes) {
      console.warn(
        `promotion_id=${promotion.id} promotion_name=${promotion.name} code_id=${c.code_id} ` +
        `code=${c.code} reason=${c.reason} promotion_remaining=${c.promotion_remaining} ` +
        `code_remaining=${c.code_remaining}`
      );
      flagged += 1;
    }

    if (applyFix && targetMaxUses !== (promotion.max_uses || 0)) {
      const diff = proposeRaisedCap(promotion, targetMaxUses);
      console.log(`Proposed fix: ${JSON.stringify(diff)} (${DRY_RUN ? "dry run" : "applying"})`);
      if (!DRY_RUN) await applyRaisedCap(promotion.id, targetMaxUses);
    }
  }

  console.log(`Done. ${checked} code(s) checked, ${flagged} code(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const applyFix = process.argv.includes("--apply");
  run(applyFix).catch((err) => { console.error(err); process.exit(1); });
}
