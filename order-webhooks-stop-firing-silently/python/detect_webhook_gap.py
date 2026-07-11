"""Detect BigCommerce order webhooks that stopped firing with no surfaced error.

BigCommerce retries a failing webhook destination on a backoff schedule for
roughly 48 hours, then permanently sets is_active to false on that
subscription, emailing only the address on file for the subscribing app.
Separately, once a destination domain has received 100 or more requests,
BigCommerce tracks a rolling 2 minute success and failure ratio and
blocklists the whole domain for 3 minutes if the success rate drops below
90 percent, which can fail deliveries even on a hook that still reads
is_active:true. Neither mechanism raises a dashboard alert. This job pulls
recent orders, the store's current hook subscriptions, and the store's own
webhook receiver log, and reports any hook that is deactivated or has gone
stale with no recent delivery. It never auto-reactivates; repair is a
separate, guarded, dry-run-respecting step.

Guide: https://www.allanninal.dev/bigcommerce/order-webhooks-stop-firing-silently/
"""
import os
import logging
from datetime import datetime, timedelta

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_webhook_gap")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "1"))
STALE_AFTER_MINUTES = int(os.environ.get("STALE_AFTER_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(base, path, params=None):
    r = requests.get(f"{base}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    if not r.text:
        return []
    return r.json()


def bc_put(base, path, body):
    r = requests.put(f"{base}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def _parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _scope_matches(scope):
    return scope.startswith("store/order/") or scope.startswith("store/customer/")


def detect_webhook_gap(order_timestamps, webhook_log_timestamps, hook_records, now, stale_after_minutes=30):
    """Pure decision. No network, no side effects.

    order_timestamps: ISO8601 date_created/date_modified values from GET /v2/orders.
    webhook_log_timestamps: {scope: [received_at ISO8601, ...]} from the store's
        own webhook receiver log.
    hook_records: raw items from GET /v3/hooks, each with id, scope, destination,
        is_active, updated_at.
    now: ISO8601 current time, injected for testability.
    stale_after_minutes: threshold beyond normal delivery latency before a
        still-active hook counts as stale.

    Returns a list of finding dicts: {hook_id, scope, destination, is_active, reason}
    with reason in {"deactivated", "stale_no_recent_delivery"}.
    """
    findings = []
    now_dt = _parse(now)
    latest_order = max((_parse(t) for t in order_timestamps), default=None)

    for hook in hook_records:
        scope = hook.get("scope", "")
        if not _scope_matches(scope):
            continue

        if not hook.get("is_active", True):
            findings.append({
                "hook_id": hook.get("id"),
                "scope": scope,
                "destination": hook.get("destination"),
                "is_active": False,
                "reason": "deactivated",
            })
            continue

        if latest_order is None:
            continue

        log_times = webhook_log_timestamps.get(scope, [])
        last_received = max((_parse(t) for t in log_times), default=None)

        gap_reference = last_received or latest_order
        stale_cutoff = now_dt - timedelta(minutes=stale_after_minutes)

        if latest_order > gap_reference and gap_reference < stale_cutoff:
            findings.append({
                "hook_id": hook.get("id"),
                "scope": scope,
                "destination": hook.get("destination"),
                "is_active": True,
                "reason": "stale_no_recent_delivery",
            })

    return findings


def recent_orders(lookback_days):
    """Page through recent orders as a timestamped ground-truth event list."""
    orders = []
    page = 1
    while True:
        batch = bc_get(API_BASE_V2, "/orders", {
            "min_date_created": f"-{lookback_days} days",
            "sort": "date_created:desc",
            "page": page,
            "limit": 50,
        })
        if not batch:
            return orders
        orders.extend(batch)
        page += 1


def current_hooks():
    result = bc_get(API_BASE_V3, "/hooks", {"limit": 250})
    return result.get("data", []) if isinstance(result, dict) else result


def load_webhook_log_timestamps():
    """Read your own webhook receiver log table, grouped by scope.

    Replace this with a real query against your receiver's storage. Left as a
    stub here since the log table is store-specific infrastructure.
    """
    return {}


def reactivate_hook(hook_id):
    """Guarded reactivation. Only call this after confirming the destination
    is healthy again. Always wrapped in DRY_RUN.
    """
    if DRY_RUN:
        log.info("DRY_RUN: would PUT /v3/hooks/%s {'is_active': True}", hook_id)
        return None
    return bc_put(API_BASE_V3, f"/hooks/{hook_id}", {"is_active": True})


def run():
    orders = recent_orders(LOOKBACK_DAYS)
    order_timestamps = [o.get("date_modified") or o.get("date_created") for o in orders if o.get("date_created")]
    hooks = current_hooks()
    webhook_log_timestamps = load_webhook_log_timestamps()
    now = datetime.utcnow().isoformat() + "Z"

    findings = detect_webhook_gap(order_timestamps, webhook_log_timestamps, hooks, now, STALE_AFTER_MINUTES)

    for finding in findings:
        log.warning(
            "webhook gap: hook_id=%s scope=%s destination=%s is_active=%s reason=%s",
            finding["hook_id"], finding["scope"], finding["destination"],
            finding["is_active"], finding["reason"],
        )

    log.info("Done. %d order(s) checked, %d hook finding(s).", len(orders), len(findings))
    return findings


if __name__ == "__main__":
    run()
