"""Reconcile BigCommerce order events missed during a deactivated webhook.

BigCommerce webhook delivery is at-least-once, but it is not durable forever.
If your endpoint returns non-2xx or times out, BigCommerce retries on a
backoff schedule for roughly 48 hours across up to 11 attempts, then gives up,
sets the hook's is_active to false, and emails the app's registered contact.
There is no dead letter queue, event log, or replay API. This scans orders
modified during the outage window, diffs each one against locally stored
state, and replays anything missing or stale through the app's own idempotent
order sync handler using freshly fetched order data. It never calls a
destructive BigCommerce write. The only write is reactivating the hook once
the backfill is confirmed.

Guide: https://www.allanninal.dev/bigcommerce/missed-webhooks-with-no-backfill/

Run once after a confirmed outage. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_missed_webhooks")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example")
TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "dummy_token")
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
WINDOW_START = os.environ.get("WINDOW_START", "1970-01-01T00:00:00+00:00")
WINDOW_END = os.environ.get("WINDOW_END", "1970-01-02T00:00:00+00:00")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def bc(method, path, **kwargs):
    """Small helper around the BigCommerce REST API. Raises on non-2xx."""
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def is_order_missed(local_state, remote_order, window_start, window_end):
    """Pure decision function. No network calls.

    local_state: {"status_id": int, "date_modified": str} | None
        The last state your app has stored for this order, or None if it has
        never been seen.
    remote_order: {"status_id": int, "date_modified": str}
        The order's current state as reported by GET /v2/orders/{id} (or the
        list endpoint).
    window_start, window_end: ISO 8601 strings
        The confirmed outage window. Only orders modified inside this window
        are candidates for replay; anything modified outside it is left for
        the normal live webhook flow to handle.

    Returns True if the order should go into the replay queue: either it was
    never recorded locally, its status_id has since moved on, or the local
    record is older than what BigCommerce now reports, provided the remote
    order's own date_modified falls within [window_start, window_end].
    """
    remote_modified = remote_order["date_modified"]
    if not (window_start <= remote_modified <= window_end):
        return False
    if local_state is None:
        return True
    if local_state["status_id"] != remote_order["status_id"]:
        return True
    return local_state["date_modified"] < remote_modified


def hooks_needing_backfill():
    """Any webhook subscription BigCommerce has deactivated after exhausting retries."""
    hooks = bc("GET", "/v3/hooks")["data"]
    return [h for h in hooks if h.get("is_active") is False]


def orders_in_window():
    """Page through GET /v2/orders across the confirmed outage window."""
    page = 1
    while True:
        rows = bc(
            "GET",
            f"/v2/orders?min_date_modified={WINDOW_START}&max_date_modified={WINDOW_END}"
            f"&limit=250&page={page}",
        )
        if not rows:
            return
        for row in rows:
            yield row
        page += 1


def load_local_state(order_id):
    """Look up your own app's last recorded state for this order.

    Replace this with your own storage layer (database, cache, etc). It must
    return {"status_id": int, "date_modified": str} or None if the order has
    never been recorded.
    """
    return None


def replay_order(order_id, sync_handler):
    """Fetch fresh order state and re-run the app's own webhook handler.

    This is a reconciliation replay, not a call to any BigCommerce write
    endpoint. It only reads from BigCommerce and invokes the same idempotent
    handler a real store_order_created or store_order_status_updated webhook
    would have triggered.
    """
    order = bc("GET", f"/v2/orders/{order_id}")
    products = bc("GET", f"/v2/orders/{order_id}/products") or []
    shipments = bc("GET", f"/v2/orders/{order_id}/shipments") or []
    transactions = bc("GET", f"/v2/orders/{order_id}/transactions") or []
    sync_handler(order, products, shipments, transactions)


def reactivate_hook(hook_id):
    """The one safe, additive BigCommerce write involved: turn the hook back on."""
    return bc("PUT", f"/v3/hooks/{hook_id}", json={"is_active": True})


def default_sync_handler(order, products, shipments, transactions):
    """Placeholder handler. Replace with your app's real order sync logic."""
    log.info("Would sync order #%s status_id=%s", order.get("id"), order.get("status_id"))


def run(sync_handler=default_sync_handler):
    replayed = 0
    for row in orders_in_window():
        local_state = load_local_state(row["id"])
        remote_order = {"status_id": int(row["status_id"]), "date_modified": row["date_modified"]}
        if not is_order_missed(local_state, remote_order, WINDOW_START, WINDOW_END):
            continue
        log.warning(
            "Order #%s missed. status_id=%s. %s",
            row["id"], row["status_id"],
            "would replay" if DRY_RUN else "replaying",
        )
        if not DRY_RUN:
            replay_order(row["id"], sync_handler)
        replayed += 1

    if not DRY_RUN:
        for hook in hooks_needing_backfill():
            log.info("Reactivating hook %s", hook["id"])
            reactivate_hook(hook["id"])

    log.info("Done. %d order(s) %s.", replayed, "to replay" if DRY_RUN else "replayed")


if __name__ == "__main__":
    STORE_HASH_REQUIRED = os.environ["BIGCOMMERCE_STORE_HASH"]
    TOKEN_REQUIRED = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
    run()
