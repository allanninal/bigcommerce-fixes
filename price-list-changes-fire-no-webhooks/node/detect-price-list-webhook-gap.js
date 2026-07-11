/**
 * Detect BigCommerce price list changes that fired no product or SKU webhook.
 *
 * BigCommerce Price Lists are a pricing overlay resolved at cart and storefront
 * time, not a mutation of the base catalog object. Writing a price list record
 * through POST or PUT /v3/pricelists/{price_list_id}/records never touches the
 * product or variant row, so it never bumps date_modified and never emits
 * store/product/updated or store/sku/updated. Price list changes instead fire
 * their own webhook family, store/priceList/record/created|updated|deleted for
 * single writes and store/priceList/records/created for batch writes, which most
 * catalog-sync integrations never subscribe to because they assumed all pricing
 * changes surface through the product/SKU scopes they already listen on. This job
 * checks which scopes are actually active, snapshots every price list's records,
 * diffs the snapshot against the previous run, and reports every changed record
 * where the active scopes prove the change was invisible to catalog webhooks. It
 * never writes to the catalog and never synthesizes a product or SKU event; the
 * only write it can make, guarded by DRY_RUN, is registering the missing
 * store/priceList/* hook subscriptions.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/price-list-changes-fire-no-webhooks/
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || "price_list_snapshot.json";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const HOOK_DESTINATION = process.env.HOOK_DESTINATION || "";

const MONEY_FIELDS = ["price", "sale_price", "retail_price", "map_price"];
const PRICE_LIST_SCOPES = new Set([
  "store/priceList/record/created",
  "store/priceList/record/updated",
  "store/priceList/record/deleted",
  "store/priceList/records/created",
]);
const CATALOG_SCOPES = new Set(["store/product/updated", "store/sku/updated"]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * previous/current: map of "price_list_id:variant_id" -> { price_list_id,
 * variant_id, price, sale_price, retail_price, map_price, currency } (money as
 * decimal strings). watchedScopes: Set of hook scopes currently registered
 * active on the store (e.g. from GET /v3/hooks).
 *
 * A record is "changed" if any of price/sale_price/retail_price/map_price
 * differs between previous and current for the same key, or if the key exists
 * only in current (new record). The change is "invisible to catalog webhooks"
 * if watchedScopes contains store/product/updated or store/sku/updated but does
 * not contain any of store/priceList/record/updated, store/priceList/record/created,
 * store/priceList/records/created. Returns a list of finding objects, most
 * relevant for reporting.
 */
export function diffPriceListRecords(previous, current, watchedScopes) {
  const watchesCatalog = [...CATALOG_SCOPES].some((scope) => watchedScopes.has(scope));
  const watchesPriceLists = [...PRICE_LIST_SCOPES].some((scope) => watchedScopes.has(scope));
  const webhookGap = watchesCatalog && !watchesPriceLists;

  const findings = [];
  for (const [key, curRecord] of Object.entries(current)) {
    const prevRecord = previous[key];
    const changedFields = MONEY_FIELDS.filter(
      (field) => !prevRecord || prevRecord[field] !== curRecord[field]
    );
    if (!changedFields.length) continue;
    findings.push({
      price_list_id: curRecord.price_list_id,
      variant_id: curRecord.variant_id,
      changed_fields: changedFields,
      webhook_gap: webhookGap,
    });
  }
  return findings;
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

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function activeHookScopes() {
  const scopes = new Set();
  let page = 1;
  while (true) {
    const payload = await bcGet("/hooks", { page, limit: 250 });
    const rows = payload.data || [];
    if (!rows.length) return scopes;
    for (const hook of rows) if (hook.is_active) scopes.add(hook.scope);
    page += 1;
  }
}

async function* allPriceListIds() {
  let page = 1;
  while (true) {
    const payload = await bcGet("/pricelists", { page, limit: 250 });
    const rows = payload.data || [];
    if (!rows.length) return;
    for (const priceList of rows) yield priceList.id;
    page += 1;
  }
}

async function priceListSnapshot() {
  const snapshot = {};
  for await (const priceListId of allPriceListIds()) {
    let page = 1;
    while (true) {
      const payload = await bcGet(`/pricelists/${priceListId}/records`, { page, limit: 250 });
      const rows = payload.data || [];
      if (!rows.length) break;
      for (const record of rows) {
        const key = `${priceListId}:${record.variant_id}`;
        snapshot[key] = {
          price_list_id: priceListId,
          variant_id: record.variant_id,
          price: String(record.price ?? ""),
          sale_price: String(record.sale_price ?? ""),
          retail_price: String(record.retail_price ?? ""),
          map_price: String(record.map_price ?? ""),
          currency: record.currency || "",
        };
      }
      page += 1;
    }
  }
  return snapshot;
}

async function loadPreviousSnapshot() {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSnapshot(snapshot) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
}

async function registerPriceListHooks(destination) {
  const created = [];
  for (const scope of [...PRICE_LIST_SCOPES].sort()) {
    await bcPost("/hooks", { scope, destination, is_active: true });
    created.push(scope);
  }
  return created;
}

export async function run() {
  const watchedScopes = await activeHookScopes();
  const previousSnapshot = await loadPreviousSnapshot();
  const currentSnapshot = await priceListSnapshot();

  const findings = diffPriceListRecords(previousSnapshot, currentSnapshot, watchedScopes);
  const detectedAt = new Date().toISOString();

  for (const finding of findings) {
    console.log(
      `price_list_id=${finding.price_list_id} variant_id=${finding.variant_id} ` +
      `changed_fields=${finding.changed_fields.join(",")} webhook_gap=${finding.webhook_gap} ` +
      `detected_at=${detectedAt}`
    );
  }

  const gapCount = findings.filter((f) => f.webhook_gap).length;
  if (gapCount && HOOK_DESTINATION) {
    console.warn(
      `${gapCount} changed record(s) invisible to catalog webhooks. Missing scopes: ${[...PRICE_LIST_SCOPES].sort()}`
    );
    if (!DRY_RUN) {
      const registered = await registerPriceListHooks(HOOK_DESTINATION);
      console.log(`Registered hook scopes: ${registered}`);
    } else {
      console.log(`Dry run, would register hook scopes: ${[...PRICE_LIST_SCOPES].sort()}`);
    }
  }

  await saveSnapshot(currentSnapshot);
  console.log(`Done. ${findings.length} changed record(s), ${gapCount} flagged as a webhook gap.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
