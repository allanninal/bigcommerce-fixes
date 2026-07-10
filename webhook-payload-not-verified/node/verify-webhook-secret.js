/**
 * Classify BigCommerce webhook requests so a handler never trusts an unverified payload.
 *
 * BigCommerce webhook callbacks carry a hash field, but BigCommerce has never published
 * a supported formula for validating it, so its presence is not real verification. The
 * documented safeguard is the optional headers object you set when creating a hook with
 * POST /v3/hooks, which BigCommerce echoes back on every callback as a shared secret.
 * This scans hooks for a missing secret, provisions one when confirmed missing, and
 * exposes a pure classification function a receiver can use before ever acting on the
 * payload. Run the scan on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/webhook-payload-not-verified/
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example";
const TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "dummy_token";
const BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const HEADER_NAME = process.env.WEBHOOK_SECRET_HEADER_NAME || "X-Webhook-Secret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Pure decision function. No network calls.
 * hook: { headers?: Record<string,string> } or {} if none configured
 * incoming: { headers: Record<string,string>, secretKeyName: string, mutationRanBeforeCheck: boolean }
 *
 * Returns one of:
 *   "UNVERIFIABLE_NO_SECRET"    - nothing was ever provisioned to check against
 *   "REJECT_MISMATCH"           - the secret header did not match
 *   "REJECT_USED_BEFORE_CHECK"  - matched, but a mutation ran before the check
 *   "TRUSTED"                  - matched, and checked before any mutation
 */
export function classifyWebhookRequest(hook, incoming) {
  const hookHeaders = hook.headers || {};
  if (Object.keys(hookHeaders).length === 0) return "UNVERIFIABLE_NO_SECRET";

  const key = incoming.secretKeyName;
  const expected = hookHeaders[key];
  const actual = (incoming.headers || {})[key];
  if (expected == null || actual == null || !constantTimeEqual(expected, actual)) {
    return "REJECT_MISMATCH";
  }

  if (incoming.mutationRanBeforeCheck) return "REJECT_USED_BEFORE_CHECK";

  return "TRUSTED";
}

async function bc(method, path, body) {
  const res = await fetch(BASE + path.replace(/^\//, ""), {
    method,
    headers: { "X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function allHooks() {
  const resp = await bc("GET", "/v3/hooks?limit=250");
  return resp?.data || [];
}

async function hooksMissingSecret() {
  return (await allHooks()).filter((h) => !h.headers || Object.keys(h.headers).length === 0);
}

async function provisionSecret(hookId, headerName) {
  const value = randomBytes(32).toString("hex");
  return bc("PUT", `/v3/hooks/${hookId}`, {
    headers: { [headerName]: value },
    is_active: true,
  });
}

export async function run() {
  let fixed = 0;
  for (const hook of await hooksMissingSecret()) {
    console.warn(
      `Hook ${hook.id} scope=${hook.scope} destination=${hook.destination} has no secret header. ${DRY_RUN ? "would provision" : "provisioning"}`
    );
    if (!DRY_RUN) await provisionSecret(hook.id, HEADER_NAME);
    fixed++;
  }
  console.log(`Done. ${fixed} hook(s) ${DRY_RUN ? "to provision" : "provisioned"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
