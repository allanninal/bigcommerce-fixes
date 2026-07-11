/**
 * Detect and repair BigCommerce stock corrupted by concurrent bulk jobs.
 *
 * BigCommerce's Inventory API processes absolute and relative adjustments
 * asynchronously through its own internal queue, and its documentation warns
 * that running Inventory API bulk operations in parallel with Catalog API or
 * Orders API bulk operations "may cause unpredictable, incorrect calculation
 * results." Relative adjustments do a read-modify-write against the current
 * stored total_inventory_onhand, so a catalog bulk edit that also touches
 * inventory_level, or an order bulk job decrementing stock, can race an
 * inventory adjustment job on the same SKU and location and silently clobber
 * or double-apply it. There is also a documented propagation delay between an
 * adjustment call returning 200 and the new value being reliably readable via
 * GET, which widens the race window.
 *
 * BigCommerce does not expose a public adjustment audit-trail endpoint, so
 * this job reconstructs the expected on-hand for each SKU and location from
 * the integration's own adjustment ledger, compares it against the actual
 * total_inventory_onhand BigCommerce reports, and pushes a corrective
 * absolute adjustment only where the two disagree beyond a tolerance. Every
 * write is re-verified with a fresh GET before the SKU is marked reconciled.
 * Gate all future inventory and catalog or order bulk jobs behind a single
 * per-store_hash mutex so this does not happen again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/concurrent-inventory-catalog-jobs-corrupt-stock/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const STOCK_TOLERANCE = Number(process.env.STOCK_TOLERANCE || 0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MAX_ITEMS_PER_ADJUSTMENT_CALL = 2000;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Returns true (flag for repair) when the actual on-hand BigCommerce
 * reports differs from the expected on-hand reconstructed from our own
 * adjustment ledger by more than tolerance. Returns false otherwise.
 */
export function isInventoryCorrupted(actualOnHand, expectedOnHand, tolerance = 0) {
  return Math.abs(actualOnHand - expectedOnHand) > tolerance;
}

/**
 * Pure payload builder. No network, no side effects.
 *
 * Returns the exact item object the absolute-adjustment request body
 * expects for one SKU and location.
 */
export function buildCorrectionPayload(sku, locationId, expectedOnHand) {
  return { location_id: locationId, sku, quantity: expectedOnHand };
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

async function* touchedProducts(jobStartTs) {
  let page = 1;
  while (true) {
    const resp = await bcGet("/catalog/products", {
      include: "variants",
      "date_modified:min": jobStartTs,
      page,
      limit: 250,
    });
    const rows = resp.data || [];
    if (!rows.length) return;
    for (const product of rows) yield product;
    page += 1;
  }
}

async function actualInventoryItems(locationId, skus) {
  if (!skus.length) return [];
  const resp = await bcGet(`/inventory/locations/${locationId}/items`, { sku__in: skus.join(",") });
  return resp.data || [];
}

/**
 * Reconstruct expected on-hand from our own adjustment log.
 *
 * ledger maps a "sku|locationId" key to the expected on-hand, built from a
 * baseline plus every relative or absolute adjustment this integration
 * issued during the overlapping window. BigCommerce does not expose a
 * public adjustment audit-trail endpoint, so this ledger has to be kept by
 * the integration itself.
 */
function expectedOnHandFromLedger(sku, locationId, ledger) {
  return ledger.get(`${sku}|${locationId}`);
}

async function pushAbsoluteAdjustment(items) {
  const body = { reason: "reconciliation-after-concurrent-jobs", items };
  return bcPut("/inventory/adjustments/absolute", body);
}

function* batched(seq, size) {
  for (let i = 0; i < seq.length; i += size) yield seq.slice(i, i + size);
}

/**
 * jobStartTs: ISO timestamp string, only products modified since this are scanned.
 * ledger: Map of "sku|locationId" -> expected on-hand number.
 *
 * In production the ledger is built from the integration's own persisted
 * adjustment history, not passed in by hand.
 */
export async function run(jobStartTs = process.env.JOB_START_TS, ledger = new Map()) {
  if (!jobStartTs) {
    throw new Error(
      "run() needs jobStartTs and a persisted adjustment ledger from your own integration. " +
      "Call run(jobStartTs, ledger) from your scheduler."
    );
  }

  const flagged = [];
  const locationIdsBySku = new Map();
  for (const key of ledger.keys()) {
    const [sku, locationIdStr] = key.split("|");
    const locationId = Number(locationIdStr);
    if (!locationIdsBySku.has(sku)) locationIdsBySku.set(sku, []);
    locationIdsBySku.get(sku).push(locationId);
  }

  for await (const product of touchedProducts(jobStartTs)) {
    const variants = product.variants && product.variants.length
      ? product.variants
      : [{ sku: product.sku, inventory_level: product.inventory_level }];

    for (const variant of variants) {
      const sku = variant.sku;
      if (!sku) continue;
      const locationIds = locationIdsBySku.get(sku) || [];
      for (const locationId of locationIds) {
        const items = await actualInventoryItems(locationId, [sku]);
        for (const item of items) {
          const actual = item.total_inventory_onhand;
          const expected = expectedOnHandFromLedger(sku, locationId, ledger);
          if (actual == null || expected == null) continue;
          if (isInventoryCorrupted(actual, expected, STOCK_TOLERANCE)) {
            flagged.push({ sku, locationId, actual, expected });
          }
        }
      }
    }
  }

  console.log(`Found ${flagged.length} SKU/location pair(s) with drift beyond tolerance ${STOCK_TOLERANCE}.`);

  let corrected = 0;
  for (const batch of batched(flagged, MAX_ITEMS_PER_ADJUSTMENT_CALL)) {
    const payloadItems = batch.map((f) => buildCorrectionPayload(f.sku, f.locationId, f.expected));

    for (const f of batch) {
      console.log(
        `sku=${f.sku} location_id=${f.locationId} actual_on_hand=${f.actual} expected_on_hand=${f.expected} ` +
        `(${DRY_RUN ? "dry run" : "correcting"})`
      );
    }
    if (DRY_RUN) continue;

    await pushAbsoluteAdjustment(payloadItems);

    const byLocation = new Map();
    for (const f of batch) {
      if (!byLocation.has(f.locationId)) byLocation.set(f.locationId, []);
      byLocation.get(f.locationId).push(f);
    }

    for (const [locationId, entries] of byLocation) {
      const skus = entries.map((e) => e.sku);
      const verifyItems = await actualInventoryItems(locationId, skus);
      const verifyBySku = new Map(verifyItems.map((i) => [i.sku, i.total_inventory_onhand]));
      for (const e of entries) {
        if (verifyBySku.get(e.sku) === e.expected) {
          corrected += 1;
        } else {
          console.warn(
            `Re-verify failed for sku=${e.sku} location_id=${locationId} expected=${e.expected} got=${verifyBySku.get(e.sku)}`
          );
        }
      }
    }
  }

  console.log(
    `Done. ${flagged.length} SKU/location pair(s) ${DRY_RUN ? "would be corrected" : `corrected (${corrected} re-verified)`}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
