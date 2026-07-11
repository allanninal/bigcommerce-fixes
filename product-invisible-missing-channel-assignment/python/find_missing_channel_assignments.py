"""Find BigCommerce products that are visible and categorized but missing from
a channel's assignment set.

Category membership and the product's is_visible flag only control whether a
product can appear within a category tree or search index. They say nothing
about which sales channel exposes the product at all. A product is only
reachable on a given channel if it has an explicit row in the
products-channel-assignments table, created with a PUT to
/v3/catalog/products/channel-assignments. New storefronts and channels do not
automatically inherit assignments from the default channel, and bulk imports,
CSV product uploads, and the default Channel Manager flow can silently skip a
newly created channel. This job lists every channel, every visible catalog
product, and every channel's assigned product ids, then reports every
(product_id, channel_id) gap. It is not safe to auto-fix blindly, a missing
assignment can be intentional for a channel-specific catalog, so by default
this only reports. Pass --repair-channel=<channel_id> to write assignments for
that one channel, guarded by DRY_RUN.

Guide: https://www.allanninal.dev/bigcommerce/product-invisible-missing-channel-assignment/
"""
import csv
import json
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_channel_assignments")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPORT_PATH = os.environ.get("REPORT_PATH", "channel_assignment_gaps.csv")

BATCH_SIZE = 50

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
    return r.json()


def find_missing_channel_assignments(
    catalog_product_ids: set, channel_assignments: dict, visible_ids: set
) -> list:
    """Pure set-difference logic. No network, no side effects.

    catalog_product_ids: the full set of catalog product ids.
    channel_assignments: channel_id -> set of product ids assigned to that
    channel, from /v3/catalog/products/channel-assignments.
    visible_ids: the subset of catalog_product_ids where is_visible is true.

    Returns a sorted list of (product_id, channel_id) pairs for every visible
    product missing from every known channel's assignment set.
    """
    gaps = []
    for channel_id, assigned_ids in channel_assignments.items():
        for product_id in catalog_product_ids:
            if product_id in visible_ids and product_id not in assigned_ids:
                gaps.append((product_id, channel_id))
    return sorted(gaps)


def all_channels():
    page = 1
    while True:
        res = bc_get("/channels", {"page": page, "limit": 250})
        data = res.get("data") or []
        if not data:
            return
        for channel in data:
            yield channel
        total_pages = (res.get("meta", {}).get("pagination", {}).get("total_pages") or page)
        if page >= total_pages:
            return
        page += 1


def visible_catalog_product_ids():
    page = 1
    all_ids = set()
    visible_ids = set()
    while True:
        res = bc_get(
            "/catalog/products",
            {"limit": 250, "page": page, "include_fields": "id,name,is_visible"},
        )
        data = res.get("data") or []
        if not data:
            break
        for product in data:
            all_ids.add(product["id"])
            if product.get("is_visible"):
                visible_ids.add(product["id"])
        total_pages = (res.get("meta", {}).get("pagination", {}).get("total_pages") or page)
        if page >= total_pages:
            break
        page += 1
    return all_ids, visible_ids


def channel_assigned_product_ids(channel_id):
    page = 1
    ids = set()
    while True:
        res = bc_get(
            "/catalog/products/channel-assignments",
            {"channel_id:in": channel_id, "limit": 250, "page": page},
        )
        data = res.get("data") or []
        if not data:
            break
        for row in data:
            ids.add(row["product_id"])
        total_pages = (res.get("meta", {}).get("pagination", {}).get("total_pages") or page)
        if page >= total_pages:
            break
        page += 1
    return ids


def repair_channel_gaps(gaps_for_channel, channel_id):
    """gaps_for_channel: list of product_id. Never call this in parallel for
    the same product_id, per BigCommerce's own guidance against overlapping
    channel-assignment requests."""
    for i in range(0, len(gaps_for_channel), BATCH_SIZE):
        batch = gaps_for_channel[i:i + BATCH_SIZE]
        body = [{"product_id": pid, "channel_id": channel_id} for pid in batch]
        log.info(
            "%s PUT channel-assignments channel_id=%s product_ids=%s",
            "DRY RUN" if DRY_RUN else "WRITING",
            channel_id, [b["product_id"] for b in body],
        )
        if not DRY_RUN:
            bc_put("/catalog/products/channel-assignments", body)


def run():
    repair_channel_id = None
    for arg in sys.argv[1:]:
        if arg.startswith("--repair-channel="):
            repair_channel_id = int(arg.split("=", 1)[1])

    channels = list(all_channels())
    log.info("Found %d channel(s).", len(channels))

    catalog_ids, visible_ids = visible_catalog_product_ids()
    log.info("Found %d catalog product(s), %d visible.", len(catalog_ids), len(visible_ids))

    channel_assignments = {}
    for channel in channels:
        channel_id = channel["id"]
        channel_assignments[channel_id] = channel_assigned_product_ids(channel_id)
        log.info(
            "Channel %s (%s): %d assigned product(s).",
            channel_id, channel.get("type"), len(channel_assignments[channel_id]),
        )

    gaps = find_missing_channel_assignments(catalog_ids, channel_assignments, visible_ids)

    with open(REPORT_PATH, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["product_id", "channel_id"])
        writer.writerows(gaps)
    log.info("Wrote %d gap(s) to %s", len(gaps), REPORT_PATH)
    log.info(json.dumps([{"product_id": p, "channel_id": c} for p, c in gaps[:20]]))

    if repair_channel_id is not None:
        gaps_for_channel = [pid for pid, cid in gaps if cid == repair_channel_id]
        log.info(
            "%s %d product(s) for channel_id=%s",
            "Would repair" if DRY_RUN else "Repairing",
            len(gaps_for_channel), repair_channel_id,
        )
        repair_channel_gaps(gaps_for_channel, repair_channel_id)

    log.info("Done. %d total gap(s) across %d channel(s).", len(gaps), len(channels))


if __name__ == "__main__":
    run()
