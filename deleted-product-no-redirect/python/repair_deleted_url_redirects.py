"""Find and repair dangling URLs left behind by deleted BigCommerce products and categories.

BigCommerce only auto-generates a 301 redirect when a product's or category's
custom_url is changed while the record still exists, the storefront URL-rewrite
history feature. Deleting the record outright, through the admin UI or
DELETE /v3/catalog/products/{id} or /v3/catalog/categories/{id}, never gives
BigCommerce an old path and a new path to reconcile, so no redirect row is ever
written and the old URL 404s indefinitely. This job keeps a snapshot of live
product and category custom_url values, diffs the previous snapshot against the
ids that are still live to find what was deleted, checks each candidate path
against the existing redirects, and upserts a 301 only for the paths that are
both confirmed deleted and confirmed uncovered. Run on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/bigcommerce/deleted-product-no-redirect/
"""
import json
import logging
import os
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_deleted_url_redirects")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
SITE_ID = int(os.environ.get("BIGCOMMERCE_SITE_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SNAPSHOT_PATH = Path(os.environ.get("SNAPSHOT_PATH", "url_snapshot.json"))
FALLBACK_TARGET = {"type": "url", "url": "/"}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def plan_redirects(previous_urls, current_ids, existing_redirect_paths, fallback_target):
    """Pure decision. No network, no side effects.

    previous_urls: dict[int, str] mapping entity id to its custom_url.url from
    the last snapshot. current_ids: set[int] of ids that are still live right
    now. existing_redirect_paths: set[str] of from_path values that already
    have a redirect. fallback_target: the "to" object to use for any new
    redirect.

    For each (id, url) in previous_urls where id is missing from current_ids
    (deleted) and url is not already in existing_redirect_paths (no redirect
    yet), emit {"from_path": url, "to": fallback_target}. Ids still present
    are skipped (not deleted). Urls already redirected are skipped (no-op,
    avoids duplicate or conflicting redirects).
    """
    plan = []
    for entity_id, url in previous_urls.items():
        if entity_id in current_ids:
            continue
        if url in existing_redirect_paths:
            continue
        plan.append({"from_path": url, "to": fallback_target})
    return plan


def snapshot_urls(resource):
    """resource is "products" or "categories". Returns dict[int, str]."""
    urls = {}
    page = 1
    while True:
        res = bc_get(
            f"/catalog/{resource}",
            {"include_fields": "custom_url,id", "page": page, "limit": 250},
        )
        for item in res.get("data", []):
            url = (item.get("custom_url") or {}).get("url")
            if url:
                urls[item["id"]] = url
        pagination = res.get("meta", {}).get("pagination", {})
        if page >= pagination.get("total_pages", page):
            return urls
        page += 1


def existing_redirect_paths(candidate_paths):
    if not candidate_paths:
        return set()
    res = bc_get("/storefront/redirects", {"path:in": ",".join(candidate_paths)})
    return {row["from_path"] for row in res.get("data", [])}


def upsert_redirects(plan):
    body = [{"from_path": item["from_path"], "site_id": SITE_ID, "to": item["to"]} for item in plan]
    return bc_put("/storefront/redirects", body)


def load_previous_snapshot():
    if not SNAPSHOT_PATH.exists():
        return {}
    with SNAPSHOT_PATH.open() as f:
        raw = json.load(f)
    return {int(k): v for k, v in raw.items()}


def save_snapshot(urls):
    with SNAPSHOT_PATH.open("w") as f:
        json.dump(urls, f)


def run():
    previous_urls = load_previous_snapshot()

    current_products = snapshot_urls("products")
    current_categories = snapshot_urls("categories")
    current_urls = {**current_products, **current_categories}
    current_ids = set(current_urls.keys())

    candidate_paths = [url for entity_id, url in previous_urls.items() if entity_id not in current_ids]
    covered = existing_redirect_paths(candidate_paths)

    plan = plan_redirects(previous_urls, current_ids, covered, FALLBACK_TARGET)

    for item in plan:
        log.info(
            "from_path=%s to=%s (%s)",
            item["from_path"], item["to"], "dry run" if DRY_RUN else "upserting",
        )

    if plan and not DRY_RUN:
        upsert_redirects(plan)
        confirmed = existing_redirect_paths([item["from_path"] for item in plan])
        for item in plan:
            if item["from_path"] not in confirmed:
                log.warning("Redirect for %s did not confirm after upsert.", item["from_path"])

    save_snapshot(current_urls)

    log.info(
        "Done. %d dangling path(s) %s.",
        len(plan), "found (dry run)" if DRY_RUN else "repaired",
    )


if __name__ == "__main__":
    run()
