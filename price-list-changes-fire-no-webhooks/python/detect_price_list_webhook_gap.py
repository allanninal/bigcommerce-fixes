"""Detect BigCommerce price list changes that fired no product or SKU webhook.

BigCommerce Price Lists are a pricing overlay resolved at cart and storefront
time, not a mutation of the base catalog object. Writing a price list record
through POST or PUT /v3/pricelists/{price_list_id}/records never touches the
product or variant row, so it never bumps date_modified and never emits
store/product/updated or store/sku/updated. Price list changes instead fire
their own webhook family, store/priceList/record/created|updated|deleted for
single writes and store/priceList/records/created for batch writes, which most
catalog-sync integrations never subscribe to because they assumed all pricing
changes surface through the product/SKU scopes they already listen on. This job
checks which scopes are actually active, snapshots every price list's records,
diffs the snapshot against the previous run, and reports every changed record
where the active scopes prove the change was invisible to catalog webhooks. It
never writes to the catalog and never synthesizes a product or SKU event; the
only write it can make, guarded by DRY_RUN, is registering the missing
store/priceList/* hook subscriptions.

Guide: https://www.allanninal.dev/bigcommerce/price-list-changes-fire-no-webhooks/
"""
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_price_list_webhook_gap")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
SNAPSHOT_PATH = os.environ.get("SNAPSHOT_PATH", "price_list_snapshot.json")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
HOOK_DESTINATION = os.environ.get("HOOK_DESTINATION", "")

MONEY_FIELDS = ("price", "sale_price", "retail_price", "map_price")
PRICE_LIST_SCOPES = {
    "store/priceList/record/created",
    "store/priceList/record/updated",
    "store/priceList/record/deleted",
    "store/priceList/records/created",
}
CATALOG_SCOPES = {"store/product/updated", "store/sku/updated"}

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def diff_price_list_records(
    previous: dict, current: dict, watched_scopes: set
) -> list:
    """Pure decision. No network, no side effects.

    previous/current: map of (price_list_id, variant_id) -> {"price", "sale_price",
    "retail_price", "map_price", "currency"} (money as decimal strings).
    watched_scopes: set of hook scopes currently registered active on the store
    (e.g. from GET /v3/hooks).

    Decision logic (no I/O):
      - A record is "changed" if any of price/sale_price/retail_price/map_price
        differs between previous and current for the same (price_list_id, variant_id),
        or if the key exists only in current (new record).
      - The change is "invisible to catalog webhooks" if watched_scopes contains
        "store/product/updated" or "store/sku/updated" but does NOT contain any of
        "store/priceList/record/updated", "store/priceList/record/created",
        "store/priceList/records/created".
      - Returns a list of finding dicts: {"price_list_id", "variant_id",
        "changed_fields", "webhook_gap": bool} for every changed record, most
        relevant for reporting.
    """
    watches_catalog = bool(watched_scopes & CATALOG_SCOPES)
    watches_price_lists = bool(watched_scopes & PRICE_LIST_SCOPES)
    webhook_gap = watches_catalog and not watches_price_lists

    findings = []
    for key, cur_record in current.items():
        prev_record = previous.get(key)
        changed_fields = [
            field
            for field in MONEY_FIELDS
            if prev_record is None or prev_record.get(field) != cur_record.get(field)
        ]
        if not changed_fields:
            continue
        price_list_id, variant_id = key
        findings.append(
            {
                "price_list_id": price_list_id,
                "variant_id": variant_id,
                "changed_fields": changed_fields,
                "webhook_gap": webhook_gap,
            }
        )
    return findings


def active_hook_scopes():
    scopes = set()
    page = 1
    while True:
        payload = bc_get("/hooks", {"page": page, "limit": 250})
        rows = payload.get("data", [])
        if not rows:
            return scopes
        for hook in rows:
            if hook.get("is_active"):
                scopes.add(hook.get("scope"))
        page += 1


def all_price_list_ids():
    page = 1
    while True:
        payload = bc_get("/pricelists", {"page": page, "limit": 250})
        rows = payload.get("data", [])
        if not rows:
            return
        for price_list in rows:
            yield price_list["id"]
        page += 1


def price_list_snapshot():
    snapshot = {}
    for price_list_id in all_price_list_ids():
        page = 1
        while True:
            payload = bc_get(
                f"/pricelists/{price_list_id}/records", {"page": page, "limit": 250}
            )
            rows = payload.get("data", [])
            if not rows:
                break
            for record in rows:
                key = (price_list_id, record["variant_id"])
                snapshot[key] = {
                    "price": str(record.get("price", "")),
                    "sale_price": str(record.get("sale_price", "")),
                    "retail_price": str(record.get("retail_price", "")),
                    "map_price": str(record.get("map_price", "")),
                    "currency": record.get("currency", ""),
                }
            page += 1
    return snapshot


def load_previous_snapshot():
    path = Path(SNAPSHOT_PATH)
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    return {tuple(item["key"]): item["record"] for item in raw}


def save_snapshot(snapshot):
    raw = [{"key": list(key), "record": record} for key, record in snapshot.items()]
    Path(SNAPSHOT_PATH).write_text(json.dumps(raw, indent=2))


def register_price_list_hooks(destination):
    created = []
    for scope in sorted(PRICE_LIST_SCOPES):
        bc_post("/hooks", {"scope": scope, "destination": destination, "is_active": True})
        created.append(scope)
    return created


def run():
    watched_scopes = active_hook_scopes()
    previous_snapshot = load_previous_snapshot()
    current_snapshot = price_list_snapshot()

    findings = diff_price_list_records(previous_snapshot, current_snapshot, watched_scopes)
    detected_at = datetime.now(timezone.utc).isoformat()

    for finding in findings:
        log.info(
            "price_list_id=%s variant_id=%s changed_fields=%s webhook_gap=%s detected_at=%s",
            finding["price_list_id"],
            finding["variant_id"],
            ",".join(finding["changed_fields"]),
            finding["webhook_gap"],
            detected_at,
        )

    gap_count = sum(1 for f in findings if f["webhook_gap"])
    if gap_count and HOOK_DESTINATION:
        log.warning(
            "%d changed record(s) invisible to catalog webhooks. Missing scopes: %s",
            gap_count, sorted(PRICE_LIST_SCOPES),
        )
        if not DRY_RUN:
            registered = register_price_list_hooks(HOOK_DESTINATION)
            log.info("Registered hook scopes: %s", registered)
        else:
            log.info("Dry run, would register hook scopes: %s", sorted(PRICE_LIST_SCOPES))

    save_snapshot(current_snapshot)
    log.info(
        "Done. %d changed record(s), %d flagged as a webhook gap.",
        len(findings), gap_count,
    )


if __name__ == "__main__":
    run()
