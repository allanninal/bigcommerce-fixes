/**
 * Serialize BigCommerce price list bulk upserts so concurrent jobs stop losing batches to 429.
 *
 * BigCommerce serializes writes to Price List records at the store level. The bulk
 * upsert endpoint, PUT /v3/pricelists/{price_list_id}/records, allows only one
 * in-flight bulk upsert job per store at a time, regardless of which price list is
 * targeted. When multiple jobs, cron tasks, or app instances submit bulk PUT batches
 * concurrently, the platform's price-list processing lock rejects every overlapping
 * request with HTTP 429, and unlike a partial-batch validation error, the entire
 * batch is dropped rather than partially applied. This script acquires a per-store
 * lock before every bulk PUT, queues competing jobs instead of racing them, and on a
 * 429 backs off with jitter and resubmits the identical batch, which is safe because
 * the endpoint upserts on variant_id or sku plus price_list_id and currency. Run one
 * instance per store.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/concurrent-price-list-upserts-429/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 6);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// In-process serialization for a single-host scheduler. For multiple hosts or
// processes, swap this for a Redis lock, e.g. SETNX pricelist:{store_hash}:bulk_lock
// with a TTL, released only after the PUT call returns a non-429 status.
let storeBulkLockHeld = false;
async function withStoreBulkLock(fn) {
  while (storeBulkLockHeld) await new Promise((r) => setTimeout(r, 25));
  storeBulkLockHeld = true;
  try {
    return await fn();
  } finally {
    storeBulkLockHeld = false;
  }
}

/**
 * Pure decision logic (no I/O) for handling a price-list bulk-upsert response.
 *
 * @param {number} statusCode HTTP status returned by PUT /v3/pricelists/{id}/records
 * @param {number} attempt 1-based count of attempts made so far for this batch
 * @param {object} headers response headers, may contain 'Retry-After' or
 *   'X-Rate-Limit-Time-Reset-Ms' (case may vary)
 * @param {number} maxAttempts cap on retry attempts before giving up
 * @returns {{action: "success"}|{action: "retry", wait_ms: number, reason: string}|{action: "give_up", reason: string}}
 *
 * Logic:
 *   - status 200/201/207 -> success (batch accepted/upserted)
 *   - status 429 and attempt < maxAttempts ->
 *         wait_ms computed from X-Rate-Limit-Time-Reset-Ms, else Retry-After,
 *         else capped exponential backoff (base 2s, cap 60s), with jitter.
 *         action retry with that wait_ms, reason "concurrent_bulk_lock"
 *   - status 429 and attempt >= maxAttempts -> give_up, reason "max_attempts_exceeded"
 *   - status 4xx (not 429) -> give_up, reason "client_error_non_retryable"
 *   - status 5xx -> retry (transient) up to maxAttempts, else give_up "server_error_max_attempts"
 */
export function decideRetry(statusCode, attempt, headers, maxAttempts = 6) {
  if ([200, 201, 207].includes(statusCode)) {
    return { action: "success" };
  }

  if (statusCode === 429) {
    if (attempt >= maxAttempts) {
      return { action: "give_up", reason: "max_attempts_exceeded" };
    }
    return {
      action: "retry",
      wait_ms: computeWaitMs(attempt, headers),
      reason: "concurrent_bulk_lock",
    };
  }

  if (statusCode >= 500 && statusCode < 600) {
    if (attempt >= maxAttempts) {
      return { action: "give_up", reason: "server_error_max_attempts" };
    }
    return {
      action: "retry",
      wait_ms: computeWaitMs(attempt, headers),
      reason: "server_error",
    };
  }

  return { action: "give_up", reason: "client_error_non_retryable" };
}

function computeWaitMs(attempt, headers) {
  headers = headers || {};
  const resetMs = headers["X-Rate-Limit-Time-Reset-Ms"] ?? headers["x-rate-limit-time-reset-ms"];
  if (resetMs !== undefined && resetMs !== null && String(resetMs).trim() !== "" && !Number.isNaN(Number(resetMs))) {
    return Number(resetMs);
  }
  const retryAfter = headers["Retry-After"] ?? headers["retry-after"];
  if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== "" && !Number.isNaN(Number(retryAfter))) {
    return Number(retryAfter) * 1000;
  }
  const base = Math.min(60000, 2000 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
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

async function bcPutRecords(priceListId, records) {
  const res = await fetch(`${API_BASE}/pricelists/${priceListId}/records`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(records),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
}

async function* allPriceLists() {
  let page = 1;
  while (true) {
    const payload = await bcGet("/pricelists", { limit: 250, page });
    const data = payload.data || [];
    if (!data.length) return;
    for (const priceList of data) yield priceList;
    const pagination = (payload.meta || {}).pagination || {};
    if (page >= (pagination.total_pages || page)) return;
    page += 1;
  }
}

async function submitBatchWithRetry(priceListId, records, maxAttempts = MAX_ATTEMPTS, dryRun = DRY_RUN) {
  let attempt = 1;
  while (true) {
    if (dryRun) {
      console.log(
        `DRY RUN: would submit batch price_list_id=${priceListId} records=${records.length} attempt=${attempt}`
      );
      return { action: "success", dry_run: true, attempt };
    }

    const { status, headers, body } = await bcPutRecords(priceListId, records);
    const decision = decideRetry(status, attempt, headers, maxAttempts);

    if (decision.action === "success") {
      console.log(`price_list_id=${priceListId} records=${records.length} upserted on attempt ${attempt}`);
      return { action: "success", attempt, body };
    }

    if (decision.action === "give_up") {
      console.error(`price_list_id=${priceListId} gave up after attempt ${attempt}: ${decision.reason}`);
      return decision;
    }

    console.warn(
      `price_list_id=${priceListId} got ${status} on attempt ${attempt}, retrying in ${decision.wait_ms}ms (${decision.reason})`
    );
    await new Promise((r) => setTimeout(r, decision.wait_ms));
    attempt += 1;
  }
}

async function runJob(priceListId, records) {
  if (DRY_RUN) {
    console.log(`DRY RUN: job for price_list_id=${priceListId} queued, would wait for store lock`);
    return submitBatchWithRetry(priceListId, records);
  }
  return withStoreBulkLock(() => submitBatchWithRetry(priceListId, records));
}

export async function run(jobs) {
  const results = [];
  for (const [priceListId, records] of jobs) {
    results.push(await runJob(priceListId, records));
  }
  const succeeded = results.filter((r) => r.action === "success").length;
  console.log(`Done. ${succeeded}/${results.length} job(s) succeeded.`);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const jobs = [];
    for await (const priceList of allPriceLists()) {
      jobs.push([priceList.id, []]);
    }
    await run(jobs);
  })().catch((err) => { console.error(err); process.exit(1); });
}
