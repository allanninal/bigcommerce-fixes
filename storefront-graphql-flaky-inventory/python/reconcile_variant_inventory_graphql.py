"""Reconcile flaky BigCommerce Storefront GraphQL variant inventory.

The Storefront GraphQL API serves inventory.aggregated.availableToSell through
cached response layers, CDN edge caching plus storefront-side caching such as a
Next.js data cache or an Apollo client cache, so a query can return a snapshot
computed before a very recent stock adjustment has propagated. This is
compounded by multi-location aggregation: aggregated stock reflects only the
store's default location by default, so an adjustment at a non-default or
newly enabled location can leave the Storefront API's aggregated figure
permanently out of step with the Management API's true total. This job pulls
each variant's true inventory_level from the REST Management API, pulls the
same variant's availableToSell from the Storefront GraphQL API, and diffs
them. A nonzero delta is re-polled after a short delay. A delta that
disappears was ordinary cache staleness. A delta that survives multiple polls
is logged as a flag for manual review, and only in DRY_RUN=false mode is the
variant's own inventory_level corrected to match the confirmed Management API
truth, never a value inferred from GraphQL. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/storefront-graphql-flaky-inventory/
"""
import os
import time
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_variant_inventory")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
STOREFRONT_TOKEN = os.environ["BIGCOMMERCE_STOREFRONT_TOKEN"]

REST_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
GRAPHQL_URL = f"https://store-{STORE_HASH}.mybigcommerce.com/graphql"

MIN_STABLE_POLLS = int(os.environ.get("MIN_STABLE_POLLS", "2"))
POLL_DELAY_SECONDS = int(os.environ.get("POLL_DELAY_SECONDS", "45"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REST_HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}
GRAPHQL_HEADERS = {
    "Authorization": f"Bearer {STOREFRONT_TOKEN}",
    "Content-Type": "application/json",
}

VARIANT_INVENTORY_QUERY = """
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
"""


def rest_get(path, params=None):
    r = requests.get(f"{REST_BASE}{path}", headers=REST_HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def rest_put(path, body):
    r = requests.put(f"{REST_BASE}{path}", headers=REST_HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def graphql_query(query, variables=None):
    r = requests.post(GRAPHQL_URL, headers=GRAPHQL_HEADERS,
                       json={"query": query, "variables": variables or {}}, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if payload.get("errors"):
        raise RuntimeError(f"GraphQL errors: {payload['errors']}")
    return payload["data"]


def diff_variant_stock(
    graphql_available_to_sell,
    rest_inventory_level: int,
    warning_level: int,
    poll_count_matching: int,
    min_stable_polls: int = 2,
) -> dict:
    """Pure decision logic (no I/O): given the Storefront GraphQL's reported
    availableToSell for a variant, the Management API's authoritative
    inventory_level, and how many consecutive polls have shown the same
    delta, decide whether this is a transient cache staleness event, a
    persistent oversell-risk mismatch to flag, or in sync.

    Returns {"status": "in_sync"|"transient"|"flag", "delta": int}.
    """
    if graphql_available_to_sell is None:
        delta = None
    else:
        delta = graphql_available_to_sell - rest_inventory_level

    if delta == 0:
        return {"status": "in_sync", "delta": 0}

    # When GraphQL returns nothing usable (None), treat the entire REST
    # inventory_level as the amount of exposure at risk, since we cannot
    # tell what the storefront is actually showing.
    safe_delta = delta if delta is not None else rest_inventory_level

    if poll_count_matching >= min_stable_polls:
        return {"status": "flag", "delta": safe_delta}

    return {"status": "transient", "delta": safe_delta}


def product_variants(product_id):
    """Page through a product's variants via the REST Management API."""
    page = 1
    while True:
        payload = rest_get(f"/catalog/products/{product_id}/variants", {"page": page, "limit": 50})
        data = payload.get("data") or []
        if not data:
            return
        for variant in data:
            yield variant
        pagination = payload.get("meta", {}).get("pagination", {})
        if page >= pagination.get("total_pages", page):
            return
        page += 1


def graphql_variant_inventory(product_entity_id):
    """Return {sku: availableToSell} for a product's variants via Storefront GraphQL."""
    data = graphql_query(VARIANT_INVENTORY_QUERY, {"entityId": product_entity_id})
    edges = data["site"]["product"]["variants"]["edges"]
    return {edge["node"]["sku"]: edge["node"]["inventory"]["aggregated"]["availableToSell"] for edge in edges}


def correct_variant_inventory(product_id, variant_id, true_inventory_level):
    """The only write this script ever makes: set inventory_level to the
    confirmed Management API truth. Never derive this value from GraphQL.
    """
    return rest_put(
        f"/catalog/products/{product_id}/variants/{variant_id}",
        {"inventory_level": true_inventory_level},
    )


def check_product(product_id):
    """Diff every variant of one product once. Returns a list of per-sku results."""
    variants = list(product_variants(product_id))
    graphql_by_sku = graphql_variant_inventory(product_id)

    results = []
    for variant in variants:
        sku = variant.get("sku")
        results.append({
            "variant_id": variant["id"],
            "sku": sku,
            "rest_inventory_level": variant.get("inventory_level", 0),
            "warning_level": variant.get("inventory_warning_level", 0),
            "graphql_available_to_sell": graphql_by_sku.get(sku),
        })
    return results


def run():
    product_ids = [int(pid) for pid in os.environ.get("PRODUCT_IDS", "").split(",") if pid.strip()]
    if not product_ids:
        log.warning("No PRODUCT_IDS configured. Set a comma separated list of product ids to check.")
        return

    poll_counts = {}
    flagged = 0
    in_sync = 0

    for product_id in product_ids:
        first_pass = check_product(product_id)

        for row in first_pass:
            key = (product_id, row["variant_id"])
            decision = diff_variant_stock(
                row["graphql_available_to_sell"], row["rest_inventory_level"],
                row["warning_level"], poll_counts.get(key, 0), MIN_STABLE_POLLS,
            )
            if decision["status"] == "in_sync":
                in_sync += 1
                continue

            log.info(
                "product_id=%s variant_id=%s sku=%s graphql_available_to_sell=%s "
                "rest_inventory_level=%s delta=%s status=%s (poll 1)",
                product_id, row["variant_id"], row["sku"], row["graphql_available_to_sell"],
                row["rest_inventory_level"], decision["delta"], decision["status"],
            )
            poll_counts[key] = 1

        if not poll_counts:
            continue

        time.sleep(POLL_DELAY_SECONDS)

        second_pass = check_product(product_id)
        for row in second_pass:
            key = (product_id, row["variant_id"])
            if key not in poll_counts:
                continue

            decision = diff_variant_stock(
                row["graphql_available_to_sell"], row["rest_inventory_level"],
                row["warning_level"], poll_counts[key], MIN_STABLE_POLLS,
            )

            if decision["status"] == "in_sync":
                log.info(
                    "product_id=%s variant_id=%s sku=%s converged after re-poll, transient cache staleness",
                    product_id, row["variant_id"], row["sku"],
                )
                in_sync += 1
                continue

            poll_counts[key] += 1
            decision = diff_variant_stock(
                row["graphql_available_to_sell"], row["rest_inventory_level"],
                row["warning_level"], poll_counts[key], MIN_STABLE_POLLS,
            )

            if decision["status"] == "flag":
                log.warning(
                    "FLAG product_id=%s variant_id=%s sku=%s graphql_available_to_sell=%s "
                    "rest_inventory_level=%s delta=%s (stable across %d polls)",
                    product_id, row["variant_id"], row["sku"], row["graphql_available_to_sell"],
                    row["rest_inventory_level"], decision["delta"], poll_counts[key],
                )
                flagged += 1
                if not DRY_RUN:
                    correct_variant_inventory(product_id, row["variant_id"], row["rest_inventory_level"])
                    log.info(
                        "Corrected variant_id=%s inventory_level to confirmed Management API truth: %s",
                        row["variant_id"], row["rest_inventory_level"],
                    )
            else:
                log.info(
                    "product_id=%s variant_id=%s sku=%s still transient after re-poll, will re-check next run",
                    product_id, row["variant_id"], row["sku"],
                )

    log.info(
        "Done. %d variant(s) in sync, %d variant(s) flagged%s.",
        in_sync, flagged, " (dry run, no writes made)" if DRY_RUN and flagged else "",
    )


if __name__ == "__main__":
    run()
