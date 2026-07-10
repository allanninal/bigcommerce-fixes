/**
 * Find and safely repair BigCommerce inventory that has drifted from real on-hand counts.
 *
 * BigCommerce's storefront "available" number is whatever inventory_level currently
 * says on the product or variant record, and that number is only as good as the
 * last write to it. Orders decrement stock, cancellations and refunds are supposed
 * to add it back, and a failed webhook, a mid-flight bulk import through the
 * Inventory API, or a manual admin edit can each leave inventory_level out of step
 * with what a warehouse recount shows. BigCommerce's own docs warn that the
 * Inventory API is "not channel aware" and that running Inventory API bulk
 * adjustments in parallel with Catalog or Orders API writes can produce
 * unpredictable, incorrect stock calculations, which is exactly the race that
 * produces silent drift.
 *
 * This pulls a counted source of truth (a WMS export, cycle-count CSV, or POS/ERP
 * feed), reads every tracked variant's sku and inventory_level from
 * GET /v3/catalog/products?include=variants, cross-checks recent order activity
 * for cancelled, declined, or refunded orders that were never restocked, and plans
 * a set of absolute inventory adjustments with a pure function. Under DRY_RUN it
 * only logs the plan. When DRY_RUN is false it submits the batch to
 * PUT /v3/inventory/adjustments/absolute and re-reads the variants to confirm the
 * counted value stuck. Never run this alongside a concurrent Catalog or Orders API
 * write on the same SKUs. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/available-drifts-from-real-on-hand/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example-store-hash";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy-token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const DEFAULT_LOCATION_ID = Number(process.env.BIGCOMMERCE_LOCATION_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Order statuses (V2) that should have restored stock. If the webhook or app that
// normally restocks a cancelled/declined/refunded order never ran, the SKU is left
// holding a lower inventory_level than reality, and that context gets attached to
// the adjustment reason so a human can see why the drift showed up.
const RESTOCK_STATUS_IDS = new Set([4, 5, 6, 14]); // Refunded, Cancelled, Declined, Partially Refunded

/**
 * Pure data transform. No network calls.
 *
 * catalogVariants: [{ sku, inventoryLevel, inventoryTracking: "none"|"product"|"variant", locationId }]
 * countedOnHand: Map<sku, number> true counted quantity from the WMS/cycle count/ERP feed.
 * recentOrderFlags: Map<sku, [{ statusId, restocked }]>
 *
 * Returns [{ sku, locationId, fromQty, toQty, reason }], one per SKU whose counted
 * quantity differs from inventory_level.
 *
 * Only variants with inventoryTracking !== "none" are eligible, since an untracked
 * variant has no inventory_level BigCommerce actually enforces. A SKU absent from
 * countedOnHand is skipped outright: with no source of truth we do not guess a
 * value. When present and different, the record is tagged "cancelled_not_restocked"
 * if recentOrderFlags shows a Cancelled(5), Declined(6), Refunded(4), or Partially
 * Refunded(14) order for that sku with restocked=false, otherwise "recount_variance".
 */
export function planInventoryReconciliation(catalogVariants, countedOnHand, recentOrderFlags) {
  const plan = [];
  for (const variant of catalogVariants) {
    if (variant.inventoryTracking === "none") continue;

    const sku = variant.sku;
    if (!countedOnHand.has(sku)) continue;

    const toQty = countedOnHand.get(sku);
    const fromQty = variant.inventoryLevel;
    if (toQty === fromQty) continue;

    let reason = "recount_variance";
    for (const flag of recentOrderFlags.get(sku) || []) {
      if (RESTOCK_STATUS_IDS.has(flag.statusId) && flag.restocked === false) {
        reason = "cancelled_not_restocked";
        break;
      }
    }

    plan.push({
      sku,
      locationId: variant.locationId ?? DEFAULT_LOCATION_ID,
      fromQty,
      toQty,
      reason,
    });
  }
  return plan;
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

/**
 * Read-only. Pages every product with its variants and yields tracked variants
 * flattened to { sku, inventoryLevel, inventoryTracking, locationId }.
 */
async function* allVariants() {
  let page = 1;
  const limit = 250;
  while (true) {
    const batch = await bc("GET", `/v3/catalog/products?include=variants&limit=${limit}&page=${page}`);
    if (!batch || !batch.length) return;
    for (const product of batch) {
      const tracking = product.inventory_tracking;
      for (const v of product.variants || []) {
        yield {
          sku: v.sku,
          inventoryLevel: v.inventory_level ?? 0,
          inventoryTracking: tracking,
          locationId: DEFAULT_LOCATION_ID,
        };
      }
    }
    if (batch.length < limit) return;
    page += 1;
  }
}

/**
 * Write path. Sets inventory_level to the counted value in one atomic override per
 * SKU using the V3 absolute adjustments endpoint. Up to 2000 items per batch.
 */
async function submitAdjustments(plan) {
  const items = plan.map((row) => ({ location_id: row.locationId, sku: row.sku, quantity: row.toQty }));
  return bc("PUT", "/v3/inventory/adjustments/absolute", { reason: "reconciliation", items });
}

export async function run(countedOnHand, recentOrderFlags) {
  const variants = [];
  for await (const v of allVariants()) variants.push(v);

  const plan = planInventoryReconciliation(variants, countedOnHand, recentOrderFlags);

  if (!plan.length) {
    console.log("Done. Nothing drifted from the counted source.");
    return;
  }

  for (const row of plan) {
    console.log(
      `SKU ${row.sku} ${DRY_RUN ? "would set" : "setting"} ${row.fromQty} -> ${row.toQty} (${row.reason})`
    );
  }

  if (!DRY_RUN) {
    await submitAdjustments(plan);
    const confirmed = new Map();
    for await (const v of allVariants()) confirmed.set(v.sku, v.inventoryLevel);
    for (const row of plan) {
      const actual = confirmed.get(row.sku);
      if (actual !== row.toQty) {
        console.warn(`SKU ${row.sku} did not confirm. Expected ${row.toQty}, saw ${actual}`);
      }
    }
  }

  console.log(`Done. ${plan.length} SKU(s) ${DRY_RUN ? "to adjust" : "adjusted"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Wire countedOnHand and recentOrderFlags up to your WMS/ERP export and
  // order-status feed before running for real.
  run(new Map(), new Map()).catch((e) => { console.error(e); process.exit(1); });
}
