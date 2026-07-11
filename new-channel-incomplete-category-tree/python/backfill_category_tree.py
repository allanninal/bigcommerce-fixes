"""Backfill a new BigCommerce storefront channel's incomplete category tree.

In BigCommerce's Multi-Storefront architecture, a category tree (a
/v3/catalog/trees object) is a standalone resource assigned to at most one
channel at a time. Creating a new storefront channel does not clone the
primary storefront's tree, so the new channel starts unassigned or pointed at
a fresh, empty tree. Because category-to-tree membership is explicit
(categories belong to a specific tree_id, not automatically to all channels),
any node created after the second channel was provisioned, or never manually
copied, produces a permanent structural gap between the two storefronts'
navigation.

This job resolves the primary and secondary channel's tree_id, pulls the
full category node set for both trees, diffs them by a stable name-and-
parent-path key with a pure function, and backfills only the missing nodes
into the secondary tree, parent-first, so every parent_id reference
resolves. Never modifies the primary tree. Safe to run again and again,
since already-backfilled nodes will match on path and be skipped.

Guide: https://www.allanninal.dev/bigcommerce/new-channel-incomplete-category-tree/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_category_tree")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
PRIMARY_CHANNEL_ID = os.environ.get("PRIMARY_CHANNEL_ID", "1")
SECONDARY_CHANNEL_ID = os.environ.get("SECONDARY_CHANNEL_ID", "2")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

MAX_BATCH = 200

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get_all(path, params=None):
    """Follow meta.pagination.links.next and return every item in data."""
    items = []
    query = dict(params or {})
    query.setdefault("limit", 250)
    page = 1
    while True:
        query["page"] = page
        r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=query, timeout=30)
        r.raise_for_status()
        body = r.json()
        items.extend(body.get("data", []))
        next_link = (body.get("meta", {}).get("pagination", {}).get("links", {}) or {}).get("next")
        if not next_link:
            return items
        page += 1


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def _build_paths(nodes):
    """Map each node id to its ancestor-name path, oldest ancestor first."""
    by_id = {n["id"]: n for n in nodes}

    def path_for(node):
        chain = []
        current = node
        seen = set()
        while current is not None:
            if current["id"] in seen:
                break
            seen.add(current["id"])
            chain.append(current["name"])
            parent_id = current.get("parent_id")
            current = by_id.get(parent_id) if parent_id else None
        return list(reversed(chain))

    return {n["id"]: path_for(n) for n in nodes}


def diff_category_trees(primary_nodes, secondary_nodes):
    """Pure. No network, no side effects.

    Builds a path string (join of ancestor names) for every node in both
    trees using parent_id chains, builds a set of secondary paths, then
    returns every primary node whose path is not in the secondary set,
    sorted by depth ascending so parent nodes are listed before their
    children.
    """
    primary_paths = _build_paths(primary_nodes)
    secondary_paths = _build_paths(secondary_nodes)
    secondary_set = {tuple(p) for p in secondary_paths.values()}

    missing = []
    for node in primary_nodes:
        path = primary_paths[node["id"]]
        if tuple(path) in secondary_set:
            continue
        missing.append({
            "path": path,
            "name": node["name"],
            "parent_path": path[:-1],
        })

    missing.sort(key=lambda m: len(m["path"]))
    return {"missing": missing}


def tree_id_for_channel(channel_id):
    trees = bc_get_all("/catalog/trees", {"channel_id:in": channel_id})
    if not trees:
        return None
    return trees[0]["id"]


def tree_categories(tree_id):
    return bc_get_all(f"/catalog/trees/{tree_id}/categories")


def backfill_batch(tree_id, categories):
    payload = [{**c, "tree_id": tree_id} for c in categories]
    return bc_post("/catalog/trees/categories", payload[:MAX_BATCH])


def run():
    primary_tree_id = tree_id_for_channel(PRIMARY_CHANNEL_ID)
    secondary_tree_id = tree_id_for_channel(SECONDARY_CHANNEL_ID)

    if primary_tree_id is None or secondary_tree_id is None:
        log.warning(
            "Could not resolve tree ids. primary_channel=%s -> %s, secondary_channel=%s -> %s",
            PRIMARY_CHANNEL_ID, primary_tree_id, SECONDARY_CHANNEL_ID, secondary_tree_id,
        )
        return

    primary_nodes = tree_categories(primary_tree_id)
    secondary_nodes = tree_categories(secondary_tree_id)

    result = diff_category_trees(primary_nodes, secondary_nodes)
    missing = result["missing"]

    if not missing:
        log.info("No gap. Secondary tree %s already matches primary tree %s.", secondary_tree_id, primary_tree_id)
        return

    name_to_new_id = {}
    for m in missing:
        parent_path = tuple(m["parent_path"])
        parent_id = name_to_new_id.get(parent_path) if parent_path else None
        log.info(
            "%s source_tree=%s target_tree=%s path=%s resolved_parent_id=%s",
            "PLAN" if DRY_RUN else "CREATE",
            primary_tree_id, secondary_tree_id, "/".join(m["path"]), parent_id,
        )
        if not DRY_RUN:
            created = backfill_batch(secondary_tree_id, [{
                "name": m["name"],
                "parent_id": parent_id or 0,
            }])
            new_id = (created.get("data") or [{}])[0].get("id")
            name_to_new_id[tuple(m["path"])] = new_id
        else:
            name_to_new_id[tuple(m["path"])] = f"<new:{'/'.join(m['path'])}>"

    log.info(
        "Done. %d node(s) %s in secondary tree %s.",
        len(missing), "planned" if DRY_RUN else "created", secondary_tree_id,
    )


if __name__ == "__main__":
    run()
