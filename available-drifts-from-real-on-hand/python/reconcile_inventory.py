"""Find and safely repair BigCommerce inventory that has drifted from real on-hand counts.

BigCommerce's storefront "available" number is whatever inventory_level currently
says on the product or variant record, and that number is only as good as the last
write to it. Orders decrement stock, cancellations and refunds are supposed to add
it back, and a failed webhook, a mid-flight bulk import through the Inventory API,
or a manual admin edit can each leave inventory_level out of step with what a
warehouse recount shows. BigCommerce's own docs warn that the Inventory API is "not
channel aware" and that running Inventory API bulk adjustments in parallel with
Catalog or Orders API writes can produce unpredictable, incorrect stock
calculations, which is exactly the race that produces silent drift.

This pulls a counted source of truth (a WMS export, cycle-count CSV, or POS/ERP
feed), reads every tracked variant's sku and inventory_level from
GET /v3/catalog/products?include=variants, cross-checks recent order activity for
cancelled, declined, or refunded orders that were never restocked, and plans a set
of absolute inventory adjustments with a pure function. Under DRY_RUN it only logs
the plan. When DRY_RUN is false it submits the batch to
PUT /v3/inventory/adjustments/absolute and re-reads the variants to confirm the
counted value stuck. Never run this alongside a concurrent Catalog or Orders API
write on the same SKUs. Safe to run again and again.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_inventory")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/"
DEFAULT_LOCATION_ID = int(os.environ.get("BIGCOMMERCE_LOCATION_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Order statuses (V2) that should have restored stock. If the webhook or app that
# normally restocks a cancelled/declined/refunded order never ran, the SKU is left
# holding a lower inventory_level than reality, and that context gets attached to
# the adjustment reason so a human can see why the drift showed up.
RESTOCK_STATUS_IDS = {4, 5, 6, 14}  # Refunded, Cancelled, Declined, Partially Refunded


def bc(method, path, **kwargs):
    r = requests.request(
        method, BASE + path.lstrip("/"),
        headers={"X-Auth-Token": TOKEN, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=30, **kwargs,
    )
    r.raise_for_status()
    if not r.content:
        return None
    body = r.json()
    return body["data"] if isinstance(body, dict) and "data" in body else body


def plan_inventory_reconciliation(catalog_variants, counted_on_hand, recent_order_flags):
    """Pure data transform. No network calls.

    catalog_variants: [{"sku": str, "inventoryLevel": int, "inventoryTracking":
        "none"|"product"|"variant", "locationId": int}]
    counted_on_hand: {sku: int} true counted quantity from the WMS/cycle count/ERP feed.
    recent_order_flags: {sku: [{"statusId": int, "restocked": bool}]}

    Returns a list of {"sku", "locationId", "fromQty", "toQty", "reason"} adjustment
    records, one per SKU whose counted quantity differs from inventory_level.

    Only variants with inventory_tracking != "none" are eligible, since an
    untracked variant has no inventory_level BigCommerce actually enforces. A SKU
    missing from counted_on_hand is skipped outright: with no source of truth we do
    not guess a value. When present and different, the record is tagged
    "cancelled_not_restocked" if recent_order_flags shows a Cancelled(5),
    Declined(6), Refunded(4), or Partially Refunded(14) order for that sku with
    restocked=False, otherwise "recount_variance".
    """
    plan = []
    for variant in catalog_variants:
        if variant.get("inventoryTracking") == "none":
            continue

        sku = variant["sku"]
        if sku not in counted_on_hand:
            continue

        to_qty = counted_on_hand[sku]
        from_qty = variant["inventoryLevel"]
        if to_qty == from_qty:
            continue

        reason = "recount_variance"
        for flag in recent_order_flags.get(sku, []):
            if flag.get("statusId") in RESTOCK_STATUS_IDS and flag.get("restocked") is False:
                reason = "cancelled_not_restocked"
                break

        plan.append({
            "sku": sku,
            "locationId": variant.get("locationId", DEFAULT_LOCATION_ID),
            "fromQty": from_qty,
            "toQty": to_qty,
            "reason": reason,
        })
    return plan


def all_variants():
    """Read-only. Pages every product with its variants and yields tracked variants
    flattened to {"sku", "inventoryLevel", "inventoryTracking", "locationId"}.
    """
    page = 1
    limit = 250
    while True:
        batch = bc("GET", f"/v3/catalog/products?include=variants&limit={limit}&page={page}")
        if not batch:
            return
        for product in batch:
            tracking = product.get("inventory_tracking")
            for v in product.get("variants") or []:
                yield {
                    "sku": v.get("sku"),
                    "inventoryLevel": v.get("inventory_level", 0),
                    "inventoryTracking": tracking,
                    "locationId": DEFAULT_LOCATION_ID,
                }
        if len(batch) < limit:
            return
        page += 1


def submit_adjustments(plan):
    """Write path. Sets inventory_level to the counted value in one atomic override
    per SKU using the V3 absolute adjustments endpoint. Up to 2000 items per batch.
    """
    items = [
        {"location_id": row["locationId"], "sku": row["sku"], "quantity": row["toQty"]}
        for row in plan
    ]
    return bc(
        "PUT",
        "/v3/inventory/adjustments/absolute",
        json={"reason": "reconciliation", "items": items},
    )


def run(counted_on_hand, recent_order_flags):
    variants = list(all_variants())
    plan = plan_inventory_reconciliation(variants, counted_on_hand, recent_order_flags)

    if not plan:
        log.info("Done. Nothing drifted from the counted source.")
        return

    for row in plan:
        log.info(
            "SKU %s %s %s -> %s (%s)",
            row["sku"], "would set" if DRY_RUN else "setting",
            row["fromQty"], row["toQty"], row["reason"],
        )

    if not DRY_RUN:
        submit_adjustments(plan)
        confirmed = {v["sku"]: v["inventoryLevel"] for v in all_variants()}
        for row in plan:
            actual = confirmed.get(row["sku"])
            if actual != row["toQty"]:
                log.warning("SKU %s did not confirm. Expected %s, saw %s", row["sku"], row["toQty"], actual)

    log.info("Done. %d SKU(s) %s.", len(plan), "to adjust" if DRY_RUN else "adjusted")


if __name__ == "__main__":
    # Wire counted_on_hand and recent_order_flags up to your WMS/ERP export and
    # order-status feed before running for real.
    run(counted_on_hand={}, recent_order_flags={})
