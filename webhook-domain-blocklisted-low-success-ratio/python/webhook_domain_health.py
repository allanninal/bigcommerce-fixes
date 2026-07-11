"""Detect a BigCommerce webhook domain at risk of being blocklisted.

BigCommerce's webhook dispatcher tracks a rolling success versus failure
ratio per destination domain over a sliding 2-minute window, evaluated only
once at least 100 requests have landed in that window. If the ratio drops
below 90 percent, typically because the receiving endpoint is slow,
returning non-200s, or intermittently down, BigCommerce blocklists the
entire domain for 3 minutes, not just the failing hook. Because the block
is domain scoped, one flaky path (for example /webhooks/orders) can starve
delivery to an unrelated healthy hook (for example /webhooks/inventory) on
the same host. If the instability persists, the same webhook can also hit
the separate 48-hour / 11-retry exhaustion path and get permanently
deactivated (is_active=false).

There is no safe API call to lift a domain blocklist or force a redelivery,
the 3-minute block self-expires and BigCommerce requeues automatically, so
this script never tries. It lists registered hooks with GET /v3/hooks,
correlates them against your own app's request log to compute rolling
success ratios per domain, reports any domain at risk and any hook already
deactivated, and makes exactly one kind of write: re-enabling a hook with
PUT /v3/hooks/{hook_id} and {"is_active": true}, and only after a synthetic
health-check request to the destination returns 200. Guarded by DRY_RUN.

Guide: https://www.allanninal.dev/bigcommerce/webhook-domain-blocklisted-low-success-ratio/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("webhook_domain_health")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
MIN_SAMPLE = int(os.environ.get("MIN_SAMPLE", "100"))
SUCCESS_THRESHOLD = float(os.environ.get("SUCCESS_THRESHOLD", "0.90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

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


def evaluate_webhook_health(window_requests: list, min_sample: int = 100, threshold: float = 0.90) -> dict:
    """Pure. No network, no side effects.

    window_requests: list of {"timestamp": float, "domain": str, "status_code": int}
    entries for a single rolling 2-minute window, one per delivery attempt.
    Returns, per domain, {"domain": str, "total": int, "success_ratio": float | None, "at_risk": bool}.
    success_ratio is None (and at_risk False) when total < min_sample, matching
    BigCommerce's rule that the ratio is not evaluated until 100 requests are seen.
    at_risk is True only when total >= min_sample and success_ratio < threshold.
    """
    by_domain = {}
    for entry in window_requests or []:
        domain = entry["domain"]
        bucket = by_domain.setdefault(domain, {"total": 0, "success": 0})
        bucket["total"] += 1
        if 200 <= entry["status_code"] < 300:
            bucket["success"] += 1

    results = {}
    for domain, bucket in by_domain.items():
        total = bucket["total"]
        if total < min_sample:
            results[domain] = {
                "domain": domain,
                "total": total,
                "success_ratio": None,
                "at_risk": False,
            }
            continue
        ratio = bucket["success"] / total
        results[domain] = {
            "domain": domain,
            "total": total,
            "success_ratio": ratio,
            "at_risk": ratio < threshold,
        }
    return results


def list_hooks():
    """Page through every registered hook via GET /v3/hooks."""
    page = 1
    while True:
        payload = bc_get("/hooks", {"page": page, "limit": 50})
        hooks = payload.get("data") or []
        if not hooks:
            return
        for hook in hooks:
            yield hook
        pagination = (payload.get("meta") or {}).get("pagination") or {}
        if page >= (pagination.get("total_pages") or page):
            return
        page += 1


def health_check_ok(destination):
    try:
        r = requests.get(destination, timeout=10)
        return r.status_code == 200
    except requests.RequestException:
        return False


def reenable_hook(hook_id, destination):
    """The only safe write: flip is_active back to True, and only when healthy."""
    if not health_check_ok(destination):
        log.warning("Skipping re-enable for hook %s, health check failed.", hook_id)
        return False
    if DRY_RUN:
        log.info("DRY_RUN: would PUT /hooks/%s {'is_active': True}", hook_id)
        return True
    bc_put(f"/hooks/{hook_id}", {"is_active": True})
    log.info("Re-enabled hook %s after passing health check.", hook_id)
    return True


def fetch_recent_request_log():
    """Placeholder for your app's own request log lookup.

    BigCommerce exposes no delivery-log or success-rate endpoint, so this
    must come from wherever your receiving app records each webhook
    request's timestamp, destination domain, and response status code.
    Replace this with a real query against your logs or metrics store.
    """
    return []


def run():
    window_requests = fetch_recent_request_log()
    health_by_domain = evaluate_webhook_health(window_requests, MIN_SAMPLE, SUCCESS_THRESHOLD)

    at_risk_count = 0
    for result in health_by_domain.values():
        if not result["at_risk"]:
            continue
        at_risk_count += 1
        log.warning(
            "Domain %s at risk of blocklisting. success_ratio=%.3f total=%d",
            result["domain"], result["success_ratio"], result["total"],
        )

    reenabled = 0
    for hook in list_hooks():
        if hook.get("is_active"):
            continue
        hook_id = hook["id"]
        destination = hook.get("destination")
        log.warning(
            "Hook %s is deactivated (is_active=false). destination=%s updated_at=%s",
            hook_id, destination, hook.get("updated_at"),
        )
        if destination and reenable_hook(hook_id, destination):
            reenabled += 1

    log.info(
        "Done. %d domain(s) at risk, %d hook(s) %s.",
        at_risk_count, reenabled, "to re-enable" if DRY_RUN else "re-enabled",
    )


if __name__ == "__main__":
    run()
