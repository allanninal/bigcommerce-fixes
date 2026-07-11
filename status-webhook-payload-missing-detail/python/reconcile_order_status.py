"""Find BigCommerce order status changes dropped by a thin webhook payload.

The store/order/statusUpdated webhook's data object carries only
{"type":"order","id":<order_id>}, never the resulting status_id. Consumers are
required to make a follow-up GET /v2/orders/{id} to learn what actually
changed. If that follow-up GET fails, times out, hits a rate limit, or the app
crashes before it completes, the status change is dropped with nothing left to
retry from, because a webhook BigCommerce delivered successfully (200 OK) is
never resent even if your own internal follow-up call fails afterward. This
job keeps a local last-known status_id per order, lists every order modified
since the last successful pass, diffs their status_id against local state, and
re-fetches each mismatch from BigCommerce so a human or a re-sync can repair
the local shadow copy. It never writes a status back to BigCommerce. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/status-webhook-payload-missing-detail/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_order_status")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_HOST = f"https://api.bigcommerce.com/stores/{STORE_HASH}"
RECONCILE_LOOKBACK_HOURS = int(os.environ.get("RECONCILE_LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STATUS_UPDATED_SCOPE = "store/order/statusUpdated"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_HOST}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def diff_order_status(known_status_by_order_id, fetched_orders):
    """Pure decision. No network, no side effects.

    For each order in fetched_orders (dict with at least id, status_id,
    date_modified), look up the locally stored last-known status_id. If there
    is no local record, or it disagrees with the order's current status_id,
    the order is a dropped update. Returns the list of all such mismatches,
    empty if everything is in sync.
    """
    mismatches = []
    for order in fetched_orders:
        order_id = order["id"]
        known = known_status_by_order_id.get(order_id)
        if known is None or known != order["status_id"]:
            mismatches.append({
                "order_id": order_id,
                "previous_known_status_id": known,
                "current_status_id": order["status_id"],
                "date_modified": order["date_modified"],
            })
    return mismatches


def orders_modified_since(last_checked_iso8601):
    page = 1
    while True:
        orders = bc_get(
            "/v2/orders",
            {
                "min_date_modified": last_checked_iso8601,
                "limit": 250,
                "page": page,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def hook_is_active(scope=STATUS_UPDATED_SCOPE):
    hooks = bc_get("/v3/hooks")
    for hook in hooks.get("data", []):
        if hook.get("scope") == scope:
            return hook.get("is_active", False)
    return False


def refetch_order(order_id):
    return bc_get(f"/v2/orders/{order_id}")


def run(known_status_by_order_id=None, last_checked_iso8601=None):
    """known_status_by_order_id and last_checked_iso8601 would normally come
    from your own persistence layer (database, file, cache). Kept as
    parameters here so the wiring stays testable and swappable.
    """
    known_status_by_order_id = known_status_by_order_id or {}
    if last_checked_iso8601 is None:
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(hours=RECONCILE_LOOKBACK_HOURS)
        last_checked_iso8601 = cutoff.strftime("%Y-%m-%dT%H:%M:%S")

    if not hook_is_active():
        log.warning(
            "store/order/statusUpdated hook is not active. This explains a "
            "systemic gap, not just isolated follow-up GET failures."
        )

    fetched_orders = list(orders_modified_since(last_checked_iso8601))
    mismatches = diff_order_status(known_status_by_order_id, fetched_orders)

    repaired = 0
    still_failing = 0
    for mismatch in mismatches:
        order_id = mismatch["order_id"]
        try:
            order = refetch_order(order_id)
        except requests.RequestException as exc:
            log.error(
                "Re-fetch failed for order_id=%s at %s: %s",
                order_id, mismatch["date_modified"], exc,
            )
            still_failing += 1
            continue

        log.info(
            "order_id=%s previous_known_status_id=%s current_status_id=%s (%s)",
            order_id, mismatch["previous_known_status_id"], order.get("status_id"),
            "dry run" if DRY_RUN else "repairing local mirror",
        )
        if not DRY_RUN:
            known_status_by_order_id[order_id] = order.get("status_id")
        repaired += 1

    log.info(
        "Done. %d dropped update(s) found, %d %s, %d failed re-fetch and will retry next pass.",
        len(mismatches), repaired, "to repair" if DRY_RUN else "repaired", still_failing,
    )
    return known_status_by_order_id


if __name__ == "__main__":
    run()
