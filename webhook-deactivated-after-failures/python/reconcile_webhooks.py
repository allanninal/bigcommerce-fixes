"""Find and safely repair BigCommerce webhooks deactivated after failures.

BigCommerce retries a failed delivery, any response that is not HTTP 2xx,
with exponential backoff for up to 11 attempts spanning roughly 48 hours.
If the destination never returns a 2xx in that window, BigCommerce sets
is_active to false on that hook and emails the app's registered address,
permanently pausing delivery. A hook can also be auto deactivated after
90 days of zero triggered events. This lists every hook with GET /v3/hooks,
diffs it against a desired manifest of scope and destination pairs, health
checks the destination before reactivating, and recreates anything missing
entirely. Run on a schedule. Safe to run again and again.
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_webhooks")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DESIRED_MANIFEST = os.environ.get("DESIRED_WEBHOOKS_JSON", "[]")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    return r.json() if r.content else None


def plan_webhook_reconciliation(desired, live):
    """Pure decision function. No network calls.

    desired: list of {"scope": str, "destination": str, "is_active": bool, "headers": dict|None}
    live: list of {"id": int, "scope": str, "destination": str, "is_active": bool}
    returns: {"toReactivate": [id], "toRecreate": [desired entry], "toLeave": [id]}

    Order of iteration over `desired` is preserved in the outputs, and neither
    input list is mutated.
    """
    by_key = {f"{h['scope']}::{h['destination']}": h for h in live}
    to_reactivate, to_recreate, to_leave = [], [], []
    for entry in desired:
        key = f"{entry['scope']}::{entry['destination']}"
        match = by_key.get(key)
        if match is None:
            to_recreate.append(entry)
        elif match["is_active"]:
            to_leave.append(match["id"])
        else:
            to_reactivate.append(match["id"])
    return {"toReactivate": to_reactivate, "toRecreate": to_recreate, "toLeave": to_leave}


def list_hooks():
    page = 1
    hooks = []
    while True:
        body = bc("GET", f"/v3/hooks?page={page}&limit=50")
        rows = (body or {}).get("data", [])
        if not rows:
            return hooks
        for row in rows:
            hooks.append({
                "id": row["id"],
                "scope": row["scope"],
                "destination": row["destination"],
                "is_active": bool(row["is_active"]),
            })
        pagination = (body.get("meta") or {}).get("pagination") or {}
        if page >= pagination.get("total_pages", page):
            return hooks
        page += 1


def get_hook(hook_id):
    body = bc("GET", f"/v3/hooks/{hook_id}")
    return (body or {}).get("data", {})


def destination_is_healthy(destination):
    if not destination.lower().startswith("https://"):
        return False
    try:
        r = requests.get(destination, timeout=10)
        return 200 <= r.status_code < 300
    except requests.RequestException:
        return False


def reactivate_hook(hook_id):
    body = bc("PUT", f"/v3/hooks/{hook_id}", json={"is_active": True})
    return (body or {}).get("data", {})


def recreate_hook(entry):
    payload = {
        "scope": entry["scope"],
        "destination": entry["destination"],
        "is_active": True,
        "headers": entry.get("headers") or {},
    }
    body = bc("POST", "/v3/hooks", json=payload)
    return (body or {}).get("data", {})


def run():
    desired = json.loads(DESIRED_MANIFEST)
    live = list_hooks()
    plan = plan_webhook_reconciliation(desired, live)

    reactivated, recreated, skipped = 0, 0, 0

    for hook_id in plan["toReactivate"]:
        hook = next((h for h in live if h["id"] == hook_id), None)
        destination = hook["destination"] if hook else None
        healthy = bool(destination) and destination_is_healthy(destination)
        if not healthy:
            log.warning("Hook %s destination not healthy yet, skipping reactivation.", hook_id)
            skipped += 1
            continue
        log.info("Hook %s healthy. %s", hook_id, "would reactivate" if DRY_RUN else "reactivating")
        if not DRY_RUN:
            reactivate_hook(hook_id)
            confirmed = get_hook(hook_id)
            if not confirmed.get("is_active"):
                raise RuntimeError(f"Hook {hook_id} did not confirm active after PUT")
        reactivated += 1

    for entry in plan["toRecreate"]:
        if not entry["destination"].lower().startswith("https://"):
            log.warning("Refusing to recreate non-HTTPS destination %s", entry["destination"])
            skipped += 1
            continue
        log.info("Missing hook for %s %s. %s", entry["scope"], entry["destination"],
                  "would recreate" if DRY_RUN else "recreating")
        if not DRY_RUN:
            created = recreate_hook(entry)
            new_id = created.get("id")
            confirmed = get_hook(new_id) if new_id else {}
            if not confirmed.get("is_active"):
                raise RuntimeError(f"New hook for {entry['scope']} did not confirm active")
        recreated += 1

    log.info("Done. %d to reactivate, %d to recreate, %d skipped, %d already healthy.",
              reactivated, recreated, skipped, len(plan["toLeave"]))


if __name__ == "__main__":
    run()
