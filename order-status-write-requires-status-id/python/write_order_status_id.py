"""Resolve a BigCommerce order status name to its status_id before writing it.

BigCommerce's V2 Orders resource models order state as a numeric status_id.
The status field returned by GET /v2/orders/{id}, for example "Awaiting
Fulfillment", is a read-only label the server computes from that id and the
store's Control Panel status-label customization. It is not an independent
writable property. Sending PUT /v2/orders/{id} with {"status": "Shipped"}
either gets silently ignored, leaving status_id unchanged, or gets rejected
if the endpoint validates strictly. It never maps the label back to an id.

This job fetches the store's own GET /v2/order_statuses list, builds a
case-insensitive name-to-id map, resolves the desired status (an int or a
name) through that map with resolve_status_id, and writes only status_id,
never the raw string. Every write is checked against an explicit allowlist
of permitted target status ids, and every write is verified by re-fetching
the order and retried once on mismatch before being flagged for review.

Guide: https://www.allanninal.dev/bigcommerce/order-status-write-requires-status-id/
"""
import os
import logging
from typing import Optional, Union

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("write_order_status_id")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ALLOWED_STATUS_IDS = frozenset(
    int(x) for x in os.environ.get("ALLOWED_STATUS_IDS", "2,9,10,11").split(",") if x.strip()
)

VALID_STATUS_IDS = frozenset(range(0, 15))

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def resolve_status_id(
    desired: Union[str, int], status_map: dict, valid_ids: frozenset = VALID_STATUS_IDS
) -> Optional[int]:
    """Pure decision. No network, no side effects.

    If desired is already an int (or a numeric string), return it only if it
    is in valid_ids, else None. If desired is a text label, normalize
    (strip/lower) and look it up in status_map (built from name,
    system_label, custom_label on GET /v2/order_statuses); return the
    matched id, or None if there is no case-insensitive match. Never returns
    a string. Callers must treat None as "do not write," not as a signal to
    fall back to sending the raw label.
    """
    if isinstance(desired, bool):
        return None
    if isinstance(desired, int):
        return desired if desired in valid_ids else None
    if isinstance(desired, str):
        stripped = desired.strip()
        if stripped.lstrip("-").isdigit():
            candidate = int(stripped)
            return candidate if candidate in valid_ids else None
        return status_map.get(stripped.lower())
    return None


def fetch_status_map():
    """Returns {lowercased label: status_id} built from GET /v2/order_statuses."""
    statuses = bc_get("/order_statuses")
    status_map = {}
    for entry in statuses or []:
        status_id = entry.get("id")
        if status_id is None:
            continue
        for label in (entry.get("name"), entry.get("system_label"), entry.get("custom_label")):
            if label:
                status_map[label.strip().lower()] = status_id
    return status_map


def write_status_id(order_id, target_status_id, attempt=1, max_attempts=2):
    bc_put(f"/orders/{order_id}", {"status_id": target_status_id})
    updated = bc_get(f"/orders/{order_id}")
    if updated.get("status_id") == target_status_id:
        return True
    if attempt < max_attempts:
        return write_status_id(order_id, target_status_id, attempt + 1, max_attempts)
    return False


def run(order_id, desired_status):
    status_map = fetch_status_map()
    resolved = resolve_status_id(desired_status, status_map)

    if resolved is None:
        log.warning(
            "order_id=%s desired=%r did not resolve to a known status_id, skipping write",
            order_id, desired_status,
        )
        return

    if resolved not in ALLOWED_STATUS_IDS:
        log.warning(
            "order_id=%s resolved status_id=%s is not in ALLOWED_STATUS_IDS=%s, flagging for review",
            order_id, resolved, sorted(ALLOWED_STATUS_IDS),
        )
        return

    current = bc_get(f"/orders/{order_id}")
    from_status_id = current.get("status_id")

    log.info(
        "order_id=%s from_status_id=%s to_status_id=%s (%s)",
        order_id, from_status_id, resolved, "dry run" if DRY_RUN else "writing",
    )

    if DRY_RUN:
        return

    if from_status_id == resolved:
        log.info("order_id=%s already at status_id=%s, no write needed", order_id, resolved)
        return

    ok = write_status_id(order_id, resolved)
    if ok:
        log.info("order_id=%s verified at status_id=%s", order_id, resolved)
    else:
        log.warning(
            "order_id=%s status_id mismatch after write and retry, flagging for manual review",
            order_id,
        )


if __name__ == "__main__":
    target_order_id = os.environ.get("ORDER_ID")
    target_status = os.environ.get("DESIRED_STATUS", "Shipped")
    if target_order_id:
        run(int(target_order_id), target_status)
    else:
        log.info("Set ORDER_ID and DESIRED_STATUS to run against a real order.")
