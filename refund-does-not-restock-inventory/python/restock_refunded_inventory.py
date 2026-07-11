"""Restock BigCommerce inventory for refunded line items that are safe to restock.

BigCommerce's refund flow, POST /v3/orders/{order_id}/payment_actions/refunds and
the legacy /v2/orders/{id}/transactions path, is scoped purely to reversing the
payment with the gateway. It records which line items and quantities were
refunded but never touches the catalog or inventory subsystem. Stock levels
(inventory_level, inventory_warning_level) live on /v3/catalog/products and its
variants and only change from order creation or cancellation triggers, direct
catalog PUTs, or the dedicated /v3/inventory/adjustments endpoints. Because
refunds are commonly partial, issued out of band, and do not always mean the
item is restockable (damaged, lost in transit, goodwill refund), BigCommerce
leaves the restock decision to the merchant, so refunded quantity and on-hand
stock silently drift apart unless something reconciles them.

This job lists orders at status_id 4 (Refunded) or 14 (Partially Refunded),
reads each order's refunds, resolves them to product_id/variant_id and
quantity, and restocks only the lines that are not already reconciled and not
flagged as damaged, lost, or return-not-received. Run on a schedule. Safe to
run again and again because reconciled refund_item_ids are recorded in a local
ledger.

Guide: https://www.allanninal.dev/bigcommerce/refund-does-not-restock-inventory/
"""
import json
import logging
import os

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restock_refunded_inventory")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE_V2 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v2"
API_BASE_V3 = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
LEDGER_PATH = os.environ.get("LEDGER_PATH", "reconciled_refunds.json")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REFUNDED = 4
PARTIALLY_REFUNDED = 14

NON_RESTOCKABLE_MARKERS = ("damaged", "lost", "return not received", "not returned")

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


def compute_restock_adjustments(refunded_lines, reconciled_ledger, skip_flags):
    """Pure decision. No network, no side effects.

    refunded_lines: [{refund_item_id, order_id, product_id, variant_id, quantity}]
    reconciled_ledger: set of refund_item_id already compensated in a prior run.
    skip_flags: refund_item_id -> True if the order/line is flagged non-restockable
    (damaged, lost, or return not received).

    Returns one adjustment per line that is unreconciled and not flagged, with
    adjustment equal to quantity (always > 0). Lines with a non-positive
    quantity are skipped defensively.
    """
    adjustments = []
    for line in refunded_lines:
        refund_item_id = line["refund_item_id"]
        if refund_item_id in reconciled_ledger:
            continue
        if skip_flags.get(refund_item_id):
            continue
        quantity = line["quantity"]
        if quantity <= 0:
            continue
        adjustments.append({
            "product_id": line["product_id"],
            "variant_id": line.get("variant_id"),
            "adjustment": quantity,
            "refund_item_id": refund_item_id,
            "order_id": line["order_id"],
        })
    return adjustments


def candidate_orders():
    """Page through orders currently Refunded or Partially Refunded."""
    page = 1
    while True:
        orders = bc_get(
            API_BASE_V2,
            "/orders",
            {
                "status_id": f"{REFUNDED},{PARTIALLY_REFUNDED}",
                "min_date_created": f"-{LOOKBACK_DAYS} days",
                "page": page,
                "limit": 50,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_refunds(order_id):
    data = bc_get(API_BASE_V3, f"/orders/{order_id}/payment_actions/refunds")
    if isinstance(data, dict):
        return data.get("data", [])
    return data or []


def order_products(order_id):
    return bc_get(API_BASE_V2, f"/orders/{order_id}/products")


def order_is_flagged_non_restockable(order_id):
    """Check order notes for a damaged/lost/return-not-received marker.

    Real stores may keep this on a custom field instead; adapt as needed.
    """
    notes = bc_get(API_BASE_V2, f"/orders/{order_id}") or {}
    staff_notes = (notes.get("staff_notes") or "").lower()
    customer_message = (notes.get("customer_message") or "").lower()
    combined = f"{staff_notes} {customer_message}"
    return any(marker in combined for marker in NON_RESTOCKABLE_MARKERS)


def resolve_refunded_lines(order_id):
    """Resolve each refund item to a concrete product_id/variant_id and quantity."""
    refunds = order_refunds(order_id)
    products_by_item_id = {p["id"]: p for p in (order_products(order_id) or [])}

    lines = []
    for refund in refunds:
        for item in refund.get("items", []):
            if item.get("item_type") != "PRODUCT":
                continue
            order_product = products_by_item_id.get(item.get("item_id"))
            if not order_product:
                continue
            lines.append({
                "refund_item_id": f"{refund.get('id')}:{item.get('item_id')}",
                "order_id": order_id,
                "product_id": order_product.get("product_id"),
                "variant_id": order_product.get("variant_id"),
                "quantity": item.get("quantity", 0),
            })
    return lines


def apply_adjustment(adjustment):
    body = {
        "reason": "refund-restock-reconciliation",
        "items": [{
            "product_id": adjustment["product_id"],
            "variant_id": adjustment["variant_id"],
            "adjustment": adjustment["adjustment"],
        }],
    }
    return bc_put(API_BASE_V3, "/inventory/adjustments/relative", body)


def load_ledger():
    if not os.path.exists(LEDGER_PATH):
        return set()
    with open(LEDGER_PATH, "r") as f:
        return set(json.load(f))


def save_ledger(ledger):
    with open(LEDGER_PATH, "w") as f:
        json.dump(sorted(ledger), f)


def run():
    ledger = load_ledger()
    restocked = 0
    skipped_flagged = 0

    for order in candidate_orders():
        order_id = order["id"]
        lines = resolve_refunded_lines(order_id)
        if not lines:
            continue

        flagged = order_is_flagged_non_restockable(order_id)
        skip_flags = {line["refund_item_id"]: flagged for line in lines}
        if flagged:
            skipped_flagged += len(lines)

        adjustments = compute_restock_adjustments(lines, ledger, skip_flags)

        for adjustment in adjustments:
            log.info(
                "product_id=%s variant_id=%s order_id=%s refund_item_id=%s adjustment=%s (%s)",
                adjustment["product_id"], adjustment["variant_id"], adjustment["order_id"],
                adjustment["refund_item_id"], adjustment["adjustment"],
                "dry run" if DRY_RUN else "restocking",
            )
            if not DRY_RUN:
                apply_adjustment(adjustment)
                ledger.add(adjustment["refund_item_id"])
            restocked += 1

    if not DRY_RUN:
        save_ledger(ledger)

    log.info(
        "Done. %d line(s) %s, %d line(s) skipped as flagged non-restockable.",
        restocked, "to restock" if DRY_RUN else "restocked", skipped_flagged,
    )


if __name__ == "__main__":
    run()
