"""Drop duplicate BigCommerce store/order/statusUpdated events fired in the same second.

BigCommerce's webhook service guarantees at-least-once delivery, not exactly-once.
If your endpoint is slow, times out, or its 200 OK response is lost in transit, the
retry mechanism re-sends the same logical event. Separately, a single admin or API
action can legitimately trigger more than one webhook subscription in the same
second, and each carries its own created_at and a hash that is not guaranteed
stable, so hash alone cannot prove a duplicate. This script keeps a short-lived
idempotency store keyed on (resource_id, new_status_id) with created_at rounded
into a window, drops repeats inside that window, confirms the order's real state
with GET /v2/orders/{id} when needed, and separately checks GET /v3/hooks for a
duplicate hook registration on the same scope and destination, which is a common
misconfiguration that doubles every delivery. It never writes to order state.

Guide: https://www.allanninal.dev/bigcommerce/webhook-duplicate-events-same-second/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dedupe_same_second_webhooks")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}"
DEDUPE_WINDOW_SECONDS = float(os.environ.get("DEDUPE_WINDOW_SECONDS", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

WATCHED_SCOPE = "store/order/statusUpdated"

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


def bc_delete(path):
    r = requests.delete(f"{API_BASE}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()


def is_duplicate_webhook_event(
    seen_events: dict, resource_id: int, new_status_id: int,
    created_at_epoch: float, window_seconds: float = DEDUPE_WINDOW_SECONDS,
) -> bool:
    """Pure decision. No network, no side effects.

    seen_events maps (resource_id, new_status_id) to the last-seen created_at
    epoch for that key. If a prior entry exists within window_seconds of the
    new event, it is a duplicate: return True and leave the store untouched.
    Otherwise record created_at_epoch for the key and return False, meaning
    the event should be processed. A different new_status_id for the same
    resource_id is treated as a distinct event, never a duplicate of the
    other status.
    """
    key = (resource_id, new_status_id)
    last_seen = seen_events.get(key)
    if last_seen is not None and abs(created_at_epoch - last_seen) <= window_seconds:
        return True
    seen_events[key] = created_at_epoch
    return False


def fetch_order_state(order_id):
    """Confirm the authoritative order state instead of trusting the payload alone."""
    order = bc_get(f"/v2/orders/{order_id}")
    return {"status_id": order.get("status_id"), "date_modified": order.get("date_modified")}


def find_duplicate_hooks(scope, destination):
    """List /v3/hooks and return every active hook matching scope and destination,
    oldest id first. More than one entry means every delivery to that destination
    is doubled by configuration, not by a retry."""
    hooks = bc_get("/v3/hooks")
    data = hooks.get("data", []) if isinstance(hooks, dict) else hooks
    matches = [h for h in data if h.get("scope") == scope and h.get("destination") == destination]
    matches.sort(key=lambda h: h.get("id", 0))
    return matches


def handle_webhook_event(seen_events, payload):
    """Process one inbound store/order/statusUpdated payload.

    Returns "processed" or "dropped_duplicate". Never mutates order state:
    the order's status_id was already applied correctly by BigCommerce, the
    bug being guarded against is redundant notification delivery.
    """
    resource_id = payload["data"]["id"]
    new_status_id = payload["data"]["status"]["new_status_id"]
    created_at_epoch = payload["created_at"]
    event_hash = payload.get("hash")

    if is_duplicate_webhook_event(seen_events, resource_id, new_status_id, created_at_epoch):
        log.info(
            "Duplicate dropped. resource_id=%s new_status_id=%s created_at=%s hash=%s",
            resource_id, new_status_id, created_at_epoch, event_hash,
        )
        return "dropped_duplicate"

    log.info(
        "Processing event. resource_id=%s new_status_id=%s created_at=%s hash=%s",
        resource_id, new_status_id, created_at_epoch, event_hash,
    )
    return "processed"


def run(destination_url):
    duplicate_hooks = find_duplicate_hooks(WATCHED_SCOPE, destination_url)

    if len(duplicate_hooks) <= 1:
        log.info("No duplicate hook registration found for scope=%s destination=%s", WATCHED_SCOPE, destination_url)
        return

    keep = duplicate_hooks[0]
    redundant = duplicate_hooks[1:]
    log.warning(
        "Found %d hooks on scope=%s destination=%s. Keeping id=%s, redundant ids=%s",
        len(duplicate_hooks), WATCHED_SCOPE, destination_url, keep.get("id"),
        [h.get("id") for h in redundant],
    )

    for hook in redundant:
        if not DRY_RUN:
            bc_delete(f"/v3/hooks/{hook['id']}")
            log.info("Deleted redundant hook id=%s", hook["id"])
        else:
            log.info("Dry run: would delete redundant hook id=%s", hook["id"])


if __name__ == "__main__":
    run(destination_url=os.environ.get("WEBHOOK_DESTINATION_URL", "https://example.com/webhooks/bigcommerce"))
