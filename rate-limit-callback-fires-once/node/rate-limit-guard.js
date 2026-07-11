/**
 * Read BigCommerce's live rate limit headers on every request instead of a one-shot callback.
 *
 * BigCommerce enforces a sliding request quota per store (default 150 requests per
 * 30,000 ms window for OAuth apps) and reports the live state on every response
 * through X-Rate-Limit-Requests-Left, X-Rate-Limit-Requests-Quota,
 * X-Rate-Limit-Time-Window-Ms, and X-Rate-Limit-Time-Reset-Ms. There is no
 * server-side webhook or push callback for rate limiting, it is purely response
 * header driven. Client libraries wire a callback into the client once, at
 * construction time, and their internal "requests remaining" counter is only
 * updated inside their own request loop rather than re-read from the live
 * headers on every call, so the callback fires a single time instead of on
 * every request that crosses the threshold. The script then free runs on
 * stale internal state and keeps colliding with the real quota, hitting
 * repeated 429 Too Many Requests responses.
 *
 * This helper reads the four headers off every response and decides, fresh
 * each time, whether to sleep before the next call. If DRY_RUN=true it only
 * replays a log of historical responses and prints the computed sleep
 * durations without making live calls. If DRY_RUN=false it applies the
 * throttling in the live request loop.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/rate-limit-callback-fires-once/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MIN_REQUESTS_REMAINING = Number(process.env.MIN_REQUESTS_REMAINING || 10);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Returns [true, timeResetMs] if statusCode === 429 or requestsLeft is
 * missing/negative/<= minRequestsRemaining, meaning the caller must sleep
 * timeResetMs before its next request. Otherwise returns [false, 0].
 * Missing or invalid header values fail safe toward throttling.
 */
export function shouldThrottle(requestsLeft, timeResetMs, minRequestsRemaining = MIN_REQUESTS_REMAINING, statusCode = 200) {
  const safeResetMs = Number.isFinite(timeResetMs) && timeResetMs > 0 ? timeResetMs : 0;

  if (statusCode === 429) return [true, safeResetMs];

  if (requestsLeft == null || requestsLeft <= minRequestsRemaining) return [true, safeResetMs];

  return [false, 0];
}

function parseRateHeaders(res) {
  const toIntOrNull = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    requestsLeft: toIntOrNull(res.headers.get("X-Rate-Limit-Requests-Left")),
    requestsQuota: toIntOrNull(res.headers.get("X-Rate-Limit-Requests-Quota")),
    windowMs: toIntOrNull(res.headers.get("X-Rate-Limit-Time-Window-Ms")) || 0,
    resetMs: toIntOrNull(res.headers.get("X-Rate-Limit-Time-Reset-Ms")) || 0,
    statusCode: res.status,
  };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  const rate = parseRateHeaders(res);
  return { res, rate };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulate throttle decisions against a replayed log, no live calls. */
export function replayDryRun(historicalResponses) {
  for (const entry of historicalResponses) {
    const [throttle, waitMs] = shouldThrottle(
      entry.requestsLeft, entry.resetMs || 0, MIN_REQUESTS_REMAINING, entry.statusCode ?? 200
    );
    console.log(
      `timestamp=${entry.timestamp} requests_left=${entry.requestsLeft} reset_ms=${entry.resetMs} ` +
      `status_code=${entry.statusCode ?? 200} throttle=${throttle} wait_ms=${throttle ? waitMs : 0}`
    );
  }
}

export async function run(paths = ["/catalog/products"]) {
  if (DRY_RUN) {
    console.log("DRY_RUN=true, replaying without live calls is expected; pass a historical log to replayDryRun().");
    return;
  }

  for (const path of paths) {
    const { rate } = await bcGet(path);
    const [throttle, waitMs] = shouldThrottle(rate.requestsLeft, rate.resetMs, MIN_REQUESTS_REMAINING, rate.statusCode);
    console.log(
      `path=${path} status_code=${rate.statusCode} requests_left=${rate.requestsLeft} reset_ms=${rate.resetMs} throttle=${throttle}`
    );
    if (throttle && waitMs > 0) await sleep(waitMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
