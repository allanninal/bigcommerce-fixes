/**
 * Edit BigCommerce coupon max_uses without wiping applies_to.
 *
 * The legacy V2 Coupons endpoint (PUT /stores/{store_hash}/v2/coupons/{id})
 * treats PUT as a full-object replace, not a true partial patch, for the
 * applies_to sub-object. BigCommerce's own docs state that if applies_to is
 * not included in the PUT request, its existing value on the coupon will be
 * cleared. A script that PUTs only {"max_uses": 50} to bump a usage cap
 * silently resets applies_to back to its default, wiping the coupon's
 * product or category restriction. The response is still 200 and every
 * other field looks correct, so the loss is silent.
 *
 * This script snapshots every coupon before any write, re-fetches the
 * freshest copy right before each PUT, always composes the PUT body by
 * merging the snapshot into desiredChanges (never a bare partial), and
 * verifies with a follow-up GET that applies_to survived. If a wipe is
 * detected, a corrective PUT resending the snapshotted applies_to is
 * logged (DRY_RUN=true) or sent and re-verified (DRY_RUN=false). Coupons
 * with no prior snapshot are flagged for manual review, never guessed.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/coupon-applies-to-wiped-on-max-uses-edit/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const WIPE_RISK_FIELDS = ["applies_to"];

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Merges desiredChanges on top of a full copy of snapshot, so the
 * returned body always re-asserts every untouched field (especially
 * applies_to) instead of omitting it. Also returns wipeRiskFields, the
 * list of fields present in snapshot but absent from desiredChanges
 * that are known to be cleared on omission by this endpoint, purely
 * for logging and assertions.
 */
export function planCouponUpdate(snapshot, desiredChanges) {
  if (!snapshot || typeof snapshot.id === "undefined") {
    throw new Error("snapshot must include an id");
  }

  const body = { ...snapshot, ...desiredChanges };
  delete body.id;

  const wipeRiskFields = WIPE_RISK_FIELDS.filter(
    (field) => field in snapshot && !(field in desiredChanges)
  );

  return {
    method: "PUT",
    path: `/coupons/${snapshot.id}`,
    body,
    wipeRiskFields,
  };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
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

async function* allCoupons() {
  let page = 1;
  while (true) {
    const coupons = await bcGet("/coupons", { limit: 250, page });
    if (!coupons.length) return;
    for (const coupon of coupons) yield coupon;
    page += 1;
  }
}

async function snapshotCoupons() {
  const snapshot = {};
  for await (const coupon of allCoupons()) snapshot[String(coupon.id)] = coupon;
  return snapshot;
}

async function applyCouponUpdate(couponId, desiredChanges, snapshotStore) {
  const key = String(couponId);
  if (!(key in snapshotStore)) {
    console.warn(
      `coupon_id=${couponId} has no prior snapshot. Flagging for manual review, not guessing applies_to.`
    );
    return { after: null, wiped: null };
  }

  const fresh = await bcGet(`/coupons/${couponId}`);
  const plan = planCouponUpdate(fresh, desiredChanges);

  console.log(
    `coupon_id=${couponId} desired_changes=${JSON.stringify(desiredChanges)} ` +
    `wipe_risk_fields=${JSON.stringify(plan.wipeRiskFields)} (${DRY_RUN ? "dry run" : "writing"})`
  );

  if (DRY_RUN) return { after: fresh, wiped: false };

  await bcPut(plan.path, plan.body);

  let after = await bcGet(`/coupons/${couponId}`);
  const expectedAppliesTo = plan.body.applies_to;
  const wiped = expectedAppliesTo !== undefined &&
    JSON.stringify(after.applies_to) !== JSON.stringify(expectedAppliesTo);

  if (wiped) {
    const correctiveBody = { ...after, applies_to: snapshotStore[key].applies_to };
    delete correctiveBody.id;
    console.warn(
      `coupon_id=${couponId} wipe detected after write. Corrective applies_to=` +
      `${JSON.stringify(snapshotStore[key].applies_to)} ` +
      `(${DRY_RUN ? "dry run, not sent" : "sending corrective PUT"})`
    );
    if (!DRY_RUN) {
      await bcPut(`/coupons/${couponId}`, correctiveBody);
      after = await bcGet(`/coupons/${couponId}`);
    }
  }

  return { after, wiped };
}

export async function run() {
  const snapshotStore = await snapshotCoupons();
  console.log(`Snapshotted ${Object.keys(snapshotStore).length} coupon(s).`);

  let wipedCount = 0;
  let flaggedCount = 0;

  for (const [couponId, coupon] of Object.entries(snapshotStore)) {
    const desiredChanges = {};
    if (Object.keys(desiredChanges).length === 0) continue;

    const { after, wiped } = await applyCouponUpdate(couponId, desiredChanges, snapshotStore);
    if (after === null) flaggedCount += 1;
    else if (wiped) wipedCount += 1;
  }

  console.log(
    `Done. ${wipedCount} coupon(s) had a wipe detected and corrected, ${flaggedCount} flagged for manual review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
