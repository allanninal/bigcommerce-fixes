/**
 * Flag BigCommerce stores whose OAuth token silently died from a scope change.
 *
 * BigCommerce invalidates a stored OAuth access token whenever the app's declared
 * scopes change in the app or Developer Portal profile. The token is only actually
 * replaced the next time the merchant reopens the app and re-consents through the
 * /auth callback, which returns a fresh access_token plus the new scope string. Any
 * script still holding the old token gets a generic 401 Unauthorized on every call
 * afterward, and there is no distinct "scope changed" error code, so scope drift and
 * plain revocation or expiry look identical unless the caller compares the scopes it
 * minted the token with against what the app currently requires.
 *
 * This script calls a lightweight canary endpoint, classifies a 401 as SCOPE_DRIFT,
 * TRANSIENT_RETRY, or TOKEN_REVOKED_OR_EXPIRED with a pure function, and only ever
 * reports. It never tries to mint a replacement token itself, because BigCommerce
 * will not issue one without the merchant re-consenting. Safe to run again and
 * again, and safe by default with DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/oauth-token-invalid-after-scope-change/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const CLIENT_ID = process.env.BIGCOMMERCE_CLIENT_ID || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  Accept: "application/json",
};

export function scopeSet(scopeString) {
  return new Set((scopeString || "").split(/\s+/).filter(Boolean));
}

/**
 * Pure decision logic, no I/O.
 *
 * Returns one of: 'OK', 'SCOPE_DRIFT', 'TOKEN_REVOKED_OR_EXPIRED', 'TRANSIENT_RETRY'.
 * - If statusCode !== 401: 'OK'.
 * - If 401 and requiredScopes has anything storedScopes lacks: 'SCOPE_DRIFT' (force
 *   re-auth, no retry).
 * - If 401, scopes match, and retryCount === 0: 'TRANSIENT_RETRY' (allow exactly
 *   one retry).
 * - If 401, scopes match, and retryCount >= 1: 'TOKEN_REVOKED_OR_EXPIRED' (force
 *   re-auth, no further retry).
 */
export function classifyAuthFailure(statusCode, storedScopes, requiredScopes, retryCount) {
  if (statusCode !== 401) return "OK";

  const missing = [...requiredScopes].some((scope) => !storedScopes.has(scope));
  if (missing) return "SCOPE_DRIFT";

  if (retryCount === 0) return "TRANSIENT_RETRY";

  return "TOKEN_REVOKED_OR_EXPIRED";
}

async function canaryStatusCode() {
  const url = new URL(`${API_BASE}/catalog/products`);
  url.searchParams.set("limit", "1");
  const res = await fetch(url, { headers: HEADERS });
  return res.status;
}

function reauthUrl(clientId, storeHash) {
  return (
    "https://login.bigcommerce.com/oauth2/authorize" +
    `?client_id=${clientId}&context=stores/${storeHash}`
  );
}

export async function run() {
  const storedScopes = scopeSet(process.env.BIGCOMMERCE_STORED_SCOPES || "");
  const requiredScopes = scopeSet(process.env.BIGCOMMERCE_REQUIRED_SCOPES || "");

  let retryCount = 0;
  let statusCode = await canaryStatusCode();
  let outcome = classifyAuthFailure(statusCode, storedScopes, requiredScopes, retryCount);

  if (outcome === "TRANSIENT_RETRY") {
    retryCount = 1;
    statusCode = await canaryStatusCode();
    outcome = classifyAuthFailure(statusCode, storedScopes, requiredScopes, retryCount);
  }

  if (outcome === "OK") {
    console.log(`store_hash=${STORE_HASH} status=OK canary_status=${statusCode}`);
    return;
  }

  const missingScopes = [...requiredScopes].filter((s) => !storedScopes.has(s)).sort();
  console.warn(
    `store_hash=${STORE_HASH} classification=${outcome} ` +
    `last_known_scope=${[...storedScopes].sort()} required_scope=${[...requiredScopes].sort()} ` +
    `missing_scopes=${missingScopes} canary_status=${statusCode} retry_count=${retryCount}`
  );

  if (!DRY_RUN) {
    console.warn(`store_hash=${STORE_HASH} re_auth_url=${reauthUrl(CLIENT_ID, STORE_HASH)}`);
  }

  console.log(
    `Done. store_hash=${STORE_HASH} stopping retries until a new access_token/scope pair is recorded.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
