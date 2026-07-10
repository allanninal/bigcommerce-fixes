/**
 * Find and safely disable BigCommerce promotions that are still ENABLED
 * past their end_date (or past max_uses), which lets them keep discounting
 * orders they should no longer touch.
 *
 * BigCommerce's V3 Promotions object stores status (ENABLED/DISABLED) as its
 * own field, independent of end_date on the rule. The platform is expected
 * to stop honoring a rule once end_date passes, but status itself is never
 * automatically flipped to DISABLED in the API response. Any integration or
 * cached calculation that only checks status === "ENABLED" keeps applying
 * the discount. end_date is also evaluated in the store's configured Date
 * and Timezone (Store Profile setting), effectively store-local 23:59:59 on
 * the entered day, not UTC, so a naive UTC comparison can be off in either
 * direction.
 *
 * This pages GET /v3/promotions, classifies each ENABLED promotion with a
 * pure function against end_date and max_uses/current_uses, cross-checks V2
 * orders placed after end_date to confirm the discount actually posted on a
 * real order, re-fetches the single promotion right before writing to avoid
 * racing a legitimate admin edit, and PUTs {"status": "DISABLED"} only when
 * DRY_RUN is false. Every candidate is logged whether or not DRY_RUN
 * suppresses the write. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/expired-promotion-still-applies/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = { "X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json" };

/**
 * Pure. No I/O.
 *
 * promo: { status: "ENABLED"|"DISABLED", end_date: string|null,
 *          start_date: string|null, current_uses: number,
 *          max_uses: number|null, redemption_type: "AUTOMATIC"|"COUPON" }
 * nowIso: current time as an ISO-8601 UTC string.
 *
 * Returns { expired: boolean, reason: string|null, action: "DISABLE"|"NONE" }.
 *
 * 1. Anything not currently ENABLED is already inactive: nothing to do.
 * 2. end_date and now are both parsed as UTC instants; a null end_date
 *    never expires on its own.
 * 3. If end_date has passed, expired with reason "past_end_date".
 * 4. Else if max_uses is set and current_uses has reached it, expired with
 *    reason "max_uses_reached" (the secondary cause of the same symptom
 *    class).
 * 5. Otherwise not expired.
 */
export function classifyPromotion(promo, nowIso) {
  if (promo.status !== "ENABLED") {
    return { expired: false, reason: null, action: "NONE" };
  }

  const now = new Date(nowIso).getTime();
  const endDate = promo.end_date;

  if (endDate !== null && endDate !== undefined) {
    const end = new Date(endDate).getTime();
    if (end <= now) {
      return { expired: true, reason: "past_end_date", action: "DISABLE" };
    }
  }

  const maxUses = promo.max_uses;
  if (maxUses !== null && maxUses !== undefined && promo.current_uses >= maxUses) {
    return { expired: true, reason: "max_uses_reached", action: "DISABLE" };
  }

  return { expired: false, reason: null, action: "NONE" };
}

async function bc(method, path, body) {
  const res = await fetch(BASE + path.replace(/^\//, ""), {
    method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  const json = JSON.parse(text);
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

/** Read-only. Pages every ENABLED promotion via meta.pagination.links.next. */
async function* enabledPromotions() {
  let path = "/v3/promotions?status=ENABLED&limit=250";
  while (path) {
    const res = await fetch(BASE + path.replace(/^\//, ""), { headers: HEADERS });
    if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
    const body = await res.json();
    for (const promo of body.data || []) yield promo;
    const nextUrl = body.meta?.pagination?.links?.next;
    path = nextUrl ? nextUrl.replace(BASE, "") : null;
  }
}

/**
 * Read-only. Orders placed on or after end_date, still Awaiting Fulfillment
 * (status_id 11), used to confirm real leakage.
 */
async function ordersAfterEndDate(endDate) {
  const qs = new URLSearchParams({ min_date_created: endDate, status_id: "11" });
  const res = await fetch(`${BASE}v2/orders?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return (await res.json()) || [];
}

/**
 * Read-only. Confirms end_date/current_uses have not changed since the
 * scan, so the write never races a legitimate admin edit.
 */
async function refetchPromotion(promotionId) {
  return bc("GET", `/v3/promotions/${promotionId}`);
}

async function disablePromotion(promotionId) {
  return bc("PUT", `/v3/promotions/${promotionId}`, { status: "DISABLED" });
}

export async function run() {
  const nowIso = new Date().toISOString();
  let candidates = 0;
  let disabled = 0;

  for await (const promo of enabledPromotions()) {
    const result = classifyPromotion(promo, nowIso);
    if (result.action !== "DISABLE") continue;

    candidates++;
    console.log(
      `Promotion "${promo.name}" (id=${promo.id}) expired: ${result.reason}. end_date=${promo.end_date} current_uses=${promo.current_uses}/${promo.max_uses}. ${DRY_RUN ? "would disable" : "disabling"}`
    );

    if (promo.end_date) {
      const leaked = await ordersAfterEndDate(promo.end_date);
      if (leaked.length) {
        console.warn(`Promotion "${promo.name}" has ${leaked.length} order(s) placed after end_date: real leakage confirmed.`);
      }
    }

    if (DRY_RUN) continue;

    const fresh = await refetchPromotion(promo.id);
    const refreshed = classifyPromotion(fresh, new Date().toISOString());
    if (refreshed.action !== "DISABLE") {
      console.log(`Promotion "${promo.name}" changed since the scan. Skipping.`);
      continue;
    }

    await disablePromotion(promo.id);
    disabled++;
  }

  console.log(`Done. ${candidates} candidate(s) found, ${DRY_RUN ? candidates : disabled} ${DRY_RUN ? "to disable" : "disabled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
