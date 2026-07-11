/**
 * Detect and repair a BigCommerce app's missing store/app/uninstalled webhook.
 *
 * BigCommerce's /v3/hooks endpoint validates the scope field against a fixed
 * allow list of exact scope strings, with no fuzzy matching or aliasing. The
 * correct, documented scope for uninstall notification is the past tense
 * store/app/uninstalled, but it is common to submit the present tense
 * store/app/uninstall, or another near miss copied from an older doc, a blog
 * post, or memory. Because the string does not match anything on the allow
 * list, BigCommerce rejects the create webhook request with a 400 rather than
 * registering a broken hook, so the app is never subscribed and silently
 * never learns when a merchant uninstalls it. This job lists every hook a
 * store has registered, classifies whether the expected scope is present and
 * active, and only when explicitly allowed re-registers the correct scope. It
 * never deletes or mutates an existing near miss hook. Run once after any app
 * config change and periodically as a safety net.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/uninstall-webhook-registration-rejected/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const UNINSTALL_WEBHOOK_URL = process.env.UNINSTALL_WEBHOOK_URL || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EXPECTED_SCOPE = "store/app/uninstalled";
const NEAR_MISS_SCOPES = new Set(["store/app/uninstall", "app/uninstalled", "store/app/Uninstalled"]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * registeredHooks: array of hook objects from GET /v3/hooks `data` array, each with
 *   keys like {id, scope, destination, is_active}.
 * Returns a decision record:
 *   {status: "ok"}
 *   {status: "missing"}
 *   {status: "inactive", hook_id}
 *   {status: "near_miss", hook_id, found_scope}
 *
 * Scans the list once. An active hook with the exact expected scope wins
 * immediately, even if a near-miss hook was seen earlier in the list. If the
 * expected scope exists but is not active, that is reported before falling
 * back to any near-miss. If nothing matches the expected scope at all, the
 * first near-miss scope found (if any) is reported, otherwise the store is
 * missing the hook entirely.
 */
export function findUninstallScopeGap(registeredHooks, expectedScope = EXPECTED_SCOPE) {
  let nearMissHook = null;

  for (const hook of registeredHooks || []) {
    const scope = hook.scope;
    if (scope === expectedScope) {
      if (hook.is_active) return { status: "ok" };
      return { status: "inactive", hook_id: hook.id };
    }
    if (NEAR_MISS_SCOPES.has(scope) && nearMissHook === null) {
      nearMissHook = hook;
    }
  }

  if (nearMissHook !== null) {
    return { status: "near_miss", hook_id: nearMissHook.id, found_scope: nearMissHook.scope };
  }

  return { status: "missing" };
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
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

async function listHooks() {
  const hooks = [];
  let page = 1;
  while (true) {
    const payload = await bcGet("/hooks", { page, limit: 50 });
    const pageHooks = payload.data || [];
    if (!pageHooks.length) return hooks;
    hooks.push(...pageHooks);
    const pagination = (payload.meta && payload.meta.pagination) || {};
    if (page >= (pagination.total_pages || page)) return hooks;
    page += 1;
  }
}

async function registerUninstallHook(destination) {
  const body = { scope: EXPECTED_SCOPE, destination, is_active: true };
  const response = await bcPost("/hooks", body);
  const data = response.data || {};
  if (data.scope !== EXPECTED_SCOPE) {
    throw new Error(`Unexpected response registering uninstall hook: ${JSON.stringify(response)}`);
  }
  return data;
}

export async function run() {
  const hooks = await listHooks();
  const decision = findUninstallScopeGap(hooks);
  const status = decision.status;

  if (status === "ok") {
    console.log(`store_hash=${STORE_HASH} status=ok. Active store/app/uninstalled hook already registered.`);
    return;
  }

  if (status === "near_miss") {
    console.warn(
      `store_hash=${STORE_HASH} status=near_miss hook_id=${decision.hook_id} found_scope=${decision.found_scope} ` +
      `expected_scope=${EXPECTED_SCOPE}. Existing hook left untouched.`
    );
  } else if (status === "inactive") {
    console.warn(`store_hash=${STORE_HASH} status=inactive hook_id=${decision.hook_id} expected_scope=${EXPECTED_SCOPE}.`);
  } else {
    console.warn(`store_hash=${STORE_HASH} status=missing expected_scope=${EXPECTED_SCOPE}.`);
  }

  if (DRY_RUN) {
    console.log(`store_hash=${STORE_HASH} dry run: would register scope=${EXPECTED_SCOPE} destination=${UNINSTALL_WEBHOOK_URL}`);
    return;
  }

  if (!UNINSTALL_WEBHOOK_URL) {
    throw new Error("UNINSTALL_WEBHOOK_URL must be set to register the uninstall hook.");
  }

  const created = await registerUninstallHook(UNINSTALL_WEBHOOK_URL);
  console.log(`store_hash=${STORE_HASH} registered scope=${EXPECTED_SCOPE} hook_id=${created.id}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
