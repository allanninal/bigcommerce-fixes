/**
 * Back off safely on BigCommerce 429s, even when rate limit headers are missing.
 *
 * BigCommerce's REST API normally returns 429 Too Many Requests with four headers,
 * X-Rate-Limit-Time-Window-Ms, X-Rate-Limit-Time-Reset-Ms, X-Rate-Limit-Requests-Quota,
 * and X-Rate-Limit-Requests-Left, so a client can compute exactly how long to wait.
 * When the platform itself is under high load, excessive traffic across a store or a
 * shared infrastructure tier, the edge or proxy layer can throttle a request before it
 * reaches the per-token accounting logic that stamps those headers, so it returns a
 * bare 429 with none of them. Client code that expects the reset header and crashes or
 * retries immediately when it is missing makes the overload worse. This helper checks
 * every 429 for the four headers, uses the exact reset time when present, and falls
 * back to a capped exponential backoff with jitter when it is not. It also logs the
 * header-less occurrence (store hash, endpoint, timestamp) for monitoring. There is
 * nothing to write back to BigCommerce here, this is a client-side guard, not a
 * store-data repair.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/429-missing-rate-limit-headers/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RATE_LIMIT_HEADERS = [
  "x-rate-limit-time-window-ms",
  "x-rate-limit-time-reset-ms",
  "x-rate-limit-requests-quota",
  "x-rate-limit-requests-left",
];
const RESET_HEADER = "x-rate-limit-time-reset-ms";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No I/O, no sleep call, no network access.
 *
 * if statusCode !== 429: return 0, no backoff needed.
 * If x-rate-limit-time-reset-ms is present (case-insensitive) and parses as a
 * non-negative number, return that value divided by 1000 as exact seconds to wait.
 * Otherwise fall back to Math.min(baseSeconds * 2**attempt, maxSeconds) with
 * +/- jitterRatio random jitter applied.
 */
export function computeBackoffSeconds(
  statusCode,
  headers,
  attempt,
  baseSeconds = 1.0,
  maxSeconds = 60.0,
  jitterRatio = 0.2,
) {
  if (statusCode !== 429) return 0;

  let resetMs = null;
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === RESET_HEADER) {
      resetMs = value;
      break;
    }
  }

  if (resetMs !== null && resetMs !== undefined && resetMs !== "") {
    const resetMsNum = Number.parseFloat(resetMs);
    if (Number.isFinite(resetMsNum) && resetMsNum >= 0) {
      return resetMsNum / 1000.0;
    }
  }

  const wait = Math.min(baseSeconds * 2 ** attempt, maxSeconds);
  const jitter = wait * jitterRatio;
  return wait + (Math.random() * 2 - 1) * jitter;
}

export function headersPresent(headers) {
  const keys = new Set(Object.keys(headers || {}).map((k) => k.toLowerCase()));
  return RATE_LIMIT_HEADERS.every((h) => keys.has(h));
}

function logHeaderlessRateLimit(path, storeHash, timestamp) {
  console.warn(`Header-less 429 detected. path=${path} store_hash=${storeHash} at=${timestamp}`);
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  const headers = Object.fromEntries(res.headers.entries());
  return { statusCode: res.status, headers, body };
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function getWithBackoff(path, params = {}, maxRetries = MAX_RETRIES) {
  let last = { statusCode: null, headers: {}, body: {} };
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    last = await bcGet(path, params);
    if (last.statusCode !== 429) return last;

    if (!headersPresent(last.headers)) {
      logHeaderlessRateLimit(path, STORE_HASH, Date.now());
      if (DRY_RUN) {
        console.log(`DRY_RUN: would back off and retry attempt=${attempt}`);
        return last;
      }
    }

    const waitSeconds = computeBackoffSeconds(last.statusCode, last.headers, attempt);
    console.log(`429 on ${path}, waiting ${waitSeconds.toFixed(2)}s before retry (attempt ${attempt})`);
    if (!DRY_RUN) await sleep(waitSeconds);
  }
  return last;
}

export async function run() {
  const { statusCode, headers } = await getWithBackoff("/catalog/products", { limit: 1 });
  console.log(`Final status=${statusCode} headers_present=${headersPresent(headers)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
