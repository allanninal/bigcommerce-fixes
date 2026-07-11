/**
 * Reconcile flaky BigCommerce Storefront GraphQL variant inventory.
 *
 * The Storefront GraphQL API serves inventory.aggregated.availableToSell through
 * cached response layers, CDN edge caching plus storefront-side caching such as a
 * Next.js data cache or an Apollo client cache, so a query can return a snapshot
 * computed before a very recent stock adjustment has propagated. This is
 * compounded by multi-location aggregation: aggregated stock reflects only the
 * store's default location by default, so an adjustment at a non-default or
 * newly enabled location can leave the Storefront API's aggregated figure
 * permanently out of step with the Management API's true total. This job pulls
 * each variant's true inventory_level from the REST Management API, pulls the
 * same variant's availableToSell from the Storefront GraphQL API, and diffs
 * them. A nonzero delta is re-polled after a short delay. A delta that
 * disappears was ordinary cache staleness. A delta that survives multiple polls
 * is logged as a flag for manual review, and only in DRY_RUN=false mode is the
 * variant's own inventory_level corrected to match the confirmed Management API
 * truth, never a value inferred from GraphQL. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/storefront-graphql-flaky-inventory/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const STOREFRONT_TOKEN = process.env.BIGCOMMERCE_STOREFRONT_TOKEN || "sf_dummy";

const REST_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const GRAPHQL_URL = `https://store-${STORE_HASH}.mybigcommerce.com/graphql`;

const MIN_STABLE_POLLS = Number(process.env.MIN_STABLE_POLLS || 2);
const POLL_DELAY_SECONDS = Number(process.env.POLL_DELAY_SECONDS || 45);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REST_HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};
const GRAPHQL_HEADERS = {
  Authorization: `Bearer ${STOREFRONT_TOKEN}`,
  "Content-Type": "application/json",
};

const VARIANT_INVENTORY_QUERY = `
query VariantInventory($entityId: Int!) {
  site {
    product(entityId: $entityId) {
      variants {
        edges {
          node {
            entityId
            sku
            inventory {
              aggregated { availableToSell, warningLevel }
              isInStock
            }
          }
        }
      }
    }
  }
}
`;

/**
 * Pure decision logic (no I/O): given the Storefront GraphQL's reported
 * availableToSell for a variant, the Management API's authoritative
 * inventory_level, and how many consecutive polls have shown the same
 * delta, decide whether this is a transient cache staleness event, a
 * persistent oversell-risk mismatch to flag, or in sync.
 *
 * Returns {"status": "in_sync"|"transient"|"flag", "delta": int}.
 */
export function diffVariantStock(graphqlAvailableToSell, restInventoryLevel, warningLevel, pollCountMatching, minStablePolls = 2) {
  let delta;
  if (graphqlAvailableToSell === null || graphqlAvailableToSell === undefined) {
    delta = null;
  } else {
    delta = graphqlAvailableToSell - restInventoryLevel;
  }

  if (delta === 0) return { status: "in_sync", delta: 0 };

  // When GraphQL returns nothing usable (null/undefined), treat the entire
  // REST inventory_level as the amount of exposure at risk, since we cannot
  // tell what the storefront is actually showing.
  const safeDelta = delta !== null ? delta : restInventoryLevel;

  if (pollCountMatching >= minStablePolls) return { status: "flag", delta: safeDelta };

  return { status: "transient", delta: safeDelta };
}

async function restGet(path, params = {}) {
  const url = new URL(`${REST_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: REST_HEADERS });
  if (!res.ok) throw new Error(`BigCommerce REST ${res.status}`);
  return res.json();
}

async function restPut(path, body) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method: "PUT",
    headers: REST_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce REST ${res.status}`);
  return res.json();
}

async function graphqlQuery(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`BigCommerce GraphQL ${res.status}`);
  const payload = await res.json();
  if (payload.errors) throw new Error(`GraphQL errors: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

async function* productVariants(productId) {
  let page = 1;
  while (true) {
    const payload = await restGet(`/catalog/products/${productId}/variants`, { page, limit: 50 });
    const data = payload.data || [];
    if (!data.length) return;
    for (const variant of data) yield variant;
    const pagination = payload.meta?.pagination || {};
    if (page >= (pagination.total_pages || page)) return;
    page += 1;
  }
}

async function graphqlVariantInventory(productEntityId) {
  const data = await graphqlQuery(VARIANT_INVENTORY_QUERY, { entityId: productEntityId });
  const edges = data.site.product.variants.edges;
  const bySku = {};
  for (const edge of edges) {
    bySku[edge.node.sku] = edge.node.inventory.aggregated.availableToSell;
  }
  return bySku;
}

async function correctVariantInventory(productId, variantId, trueInventoryLevel) {
  // The only write this script ever makes: set inventory_level to the
  // confirmed Management API truth. Never derive this value from GraphQL.
  return restPut(`/catalog/products/${productId}/variants/${variantId}`, { inventory_level: trueInventoryLevel });
}

async function checkProduct(productId) {
  const variants = [];
  for await (const variant of productVariants(productId)) variants.push(variant);
  const graphqlBySku = await graphqlVariantInventory(productId);

  return variants.map((variant) => ({
    variantId: variant.id,
    sku: variant.sku,
    restInventoryLevel: variant.inventory_level ?? 0,
    warningLevel: variant.inventory_warning_level ?? 0,
    graphqlAvailableToSell: graphqlBySku[variant.sku] ?? null,
  }));
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function run() {
  const productIds = (process.env.PRODUCT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number);

  if (!productIds.length) {
    console.warn("No PRODUCT_IDS configured. Set a comma separated list of product ids to check.");
    return;
  }

  const pollCounts = new Map();
  let flagged = 0;
  let inSync = 0;

  for (const productId of productIds) {
    const firstPass = await checkProduct(productId);

    for (const row of firstPass) {
      const key = `${productId}:${row.variantId}`;
      const decision = diffVariantStock(row.graphqlAvailableToSell, row.restInventoryLevel, row.warningLevel, pollCounts.get(key) || 0, MIN_STABLE_POLLS);
      if (decision.status === "in_sync") {
        inSync += 1;
        continue;
      }
      console.log(
        `product_id=${productId} variant_id=${row.variantId} sku=${row.sku} graphql_available_to_sell=${row.graphqlAvailableToSell} ` +
        `rest_inventory_level=${row.restInventoryLevel} delta=${decision.delta} status=${decision.status} (poll 1)`
      );
      pollCounts.set(key, 1);
    }

    if (!pollCounts.size) continue;

    await sleep(POLL_DELAY_SECONDS);

    const secondPass = await checkProduct(productId);
    for (const row of secondPass) {
      const key = `${productId}:${row.variantId}`;
      if (!pollCounts.has(key)) continue;

      let decision = diffVariantStock(row.graphqlAvailableToSell, row.restInventoryLevel, row.warningLevel, pollCounts.get(key), MIN_STABLE_POLLS);

      if (decision.status === "in_sync") {
        console.log(`product_id=${productId} variant_id=${row.variantId} sku=${row.sku} converged after re-poll, transient cache staleness`);
        inSync += 1;
        continue;
      }

      pollCounts.set(key, pollCounts.get(key) + 1);
      decision = diffVariantStock(row.graphqlAvailableToSell, row.restInventoryLevel, row.warningLevel, pollCounts.get(key), MIN_STABLE_POLLS);

      if (decision.status === "flag") {
        console.warn(
          `FLAG product_id=${productId} variant_id=${row.variantId} sku=${row.sku} graphql_available_to_sell=${row.graphqlAvailableToSell} ` +
          `rest_inventory_level=${row.restInventoryLevel} delta=${decision.delta} (stable across ${pollCounts.get(key)} polls)`
        );
        flagged += 1;
        if (!DRY_RUN) {
          await correctVariantInventory(productId, row.variantId, row.restInventoryLevel);
          console.log(`Corrected variant_id=${row.variantId} inventory_level to confirmed Management API truth: ${row.restInventoryLevel}`);
        }
      } else {
        console.log(`product_id=${productId} variant_id=${row.variantId} sku=${row.sku} still transient after re-poll, will re-check next run`);
      }
    }
  }

  console.log(`Done. ${inSync} variant(s) in sync, ${flagged} variant(s) flagged${DRY_RUN && flagged ? " (dry run, no writes made)" : ""}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
