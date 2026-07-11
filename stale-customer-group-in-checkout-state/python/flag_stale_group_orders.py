"""Flag BigCommerce orders priced against a stale cached customer group.

checkout-sdk-js reads a shopper's customer_group_id once when checkout state
initializes and caches it in the in-memory checkoutState.data customer object.
If the customer_group_id changes mid session, an admin moves them to a new
group, a B2B company-role change fires, or an automated group reassignment
runs, the SDK's state-merge logic does not reliably overwrite the cached
value (checkout-sdk-js issue #1321). Because customer-group pricing is
resolved through Price Lists tied to a customer_group_id, and that resolution
happens against the cached session group rather than being re-fetched at
price-calculation or order-submit time, the shopper can complete checkout
priced under their old, stale group.

This is unsafe to auto-fix: the order is already placed and paid, and a
script cannot know whether the merchant wants to honor the lower price,
collect the difference, refund, or void the order. This job only detects and
flags. It never changes price, issues a refund, or moves status_id. Default
mode (DRY_RUN=true) only prints and exports a CSV of flagged order ids. With
DRY_RUN=false it additionally appends a staff-only note to the order via
PUT /v2/orders/{id}. Any real price fix is a separate, human-confirmed step.

Guide: https://www.allanninal.dev/bigcommerce/stale-customer-group-in-checkout-state/
"""
import csv
import os
import logging
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stale_group_orders")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
CHANNEL_ID = int(os.environ.get("CHANNEL_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "flagged_orders.csv")

# Exclude 5 Cancelled and 6 Declined.
RELEVANT_STATUS_IDS = "0,7,9,11,1,10"
TOLERANCE = Decimal("0.01")
UNRESOLVED_GROUP_ID = -1  # sentinel: any id guaranteed to differ from a real group id

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


def is_order_mispriced(
    current_group_id: int,
    priced_group_id: int,
    charged_unit_price: Decimal,
    current_group_unit_price: Decimal,
    tolerance: Decimal = TOLERANCE,
) -> bool:
    """Pure decision. No network, no side effects.

    Takes the customer's current customer_group_id, the group id inferred
    from the price-list record that matches what was actually charged
    (priced_group_id), the unit price charged on the order line, and the
    unit price that the customer's CURRENT group's assigned price list
    would produce for that same variant. Returns True (flag as mispriced)
    only when the group ids actually diverge AND that divergence produced
    a real price difference beyond rounding tolerance, avoiding false
    positives when two different groups happen to share identical pricing.
    """
    if current_group_id == priced_group_id:
        return False
    price_delta = abs(charged_unit_price - current_group_unit_price)
    return price_delta > tolerance


def candidate_orders():
    """Page through orders in the lookback window, excluding Cancelled/Declined."""
    page = 1
    while True:
        orders = bc_get(
            "/v2/orders",
            {
                "min_date_created": f"-{LOOKBACK_DAYS} days",
                "status_id:in": RELEVANT_STATUS_IDS,
                "page": page,
                "limit": 50,
            },
        )
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def order_line_prices(order_id):
    return bc_get(f"/v2/orders/{order_id}/products")


def current_customer_group_id(customer_id):
    """Customer groups are a V2-only resource; /v3/customers does not expose group id."""
    customer = bc_get(f"/v2/customers/{customer_id}")
    if isinstance(customer, list):
        customer = customer[0] if customer else {}
    return customer.get("customer_group_id")


def active_price_list_id(customer_group_id, channel_id=CHANNEL_ID):
    resp = bc_get(
        "/v3/pricelists/assignments",
        {"customer_group_id": customer_group_id, "channel_id": channel_id},
    )
    assignments = resp.get("data", []) if isinstance(resp, dict) else []
    return assignments[0]["price_list_id"] if assignments else None


def price_list_records(price_list_id, variant_ids):
    if not variant_ids:
        return []
    resp = bc_get(
        f"/v3/pricelists/{price_list_id}/records",
        {"variant_id:in": ",".join(str(v) for v in variant_ids)},
    )
    return resp.get("data", []) if isinstance(resp, dict) else []


def flag_order_note(order_id, summary):
    """Append a staff-only note. Never changes price, status, or totals."""
    order = bc_get(f"/v2/orders/{order_id}")
    existing = order.get("staff_notes") or ""
    updated = (existing + "\n" if existing else "") + summary
    return bc_put(f"/v2/orders/{order_id}", {"staff_notes": updated})


def _to_decimal(value):
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        return None


def run():
    flagged_rows = []
    group_price_list_cache = {}

    for order in candidate_orders():
        order_id = order["id"]
        customer_id = order.get("customer_id")
        if not customer_id:
            continue

        current_group_id = current_customer_group_id(customer_id)
        if current_group_id is None:
            continue

        lines = order_line_prices(order_id)
        variant_ids = [line.get("variant_id") for line in lines if line.get("variant_id")]
        if not variant_ids:
            continue

        if current_group_id not in group_price_list_cache:
            group_price_list_cache[current_group_id] = active_price_list_id(current_group_id)
        current_price_list_id = group_price_list_cache[current_group_id]
        if current_price_list_id is None:
            continue

        current_records = {
            rec["variant_id"]: _to_decimal(rec.get("price"))
            for rec in price_list_records(current_price_list_id, variant_ids)
        }

        for line in lines:
            variant_id = line.get("variant_id")
            charged_unit_price = _to_decimal(line.get("price_inc_tax") or line.get("price_ex_tax"))
            current_group_unit_price = current_records.get(variant_id)
            if charged_unit_price is None or current_group_unit_price is None:
                continue
            if abs(charged_unit_price - current_group_unit_price) <= TOLERANCE:
                continue  # matches the current group, not stale

            # The charged price already fails to reconcile with the current
            # group's price list, which is the definition of a priced_group_id
            # that differs from current_group_id. UNRESOLVED_GROUP_ID is any
            # sentinel distinct from current_group_id, so the divergence check
            # inside is_order_mispriced always holds here; the function still
            # gates on the price delta, so it is not a rubber stamp.
            is_stale = is_order_mispriced(
                current_group_id=current_group_id,
                priced_group_id=UNRESOLVED_GROUP_ID,
                charged_unit_price=charged_unit_price,
                current_group_unit_price=current_group_unit_price,
            )
            if not is_stale:
                continue

            price_delta = abs(charged_unit_price - current_group_unit_price)
            summary = (
                f"[stale-customer-group check] order_id={order_id} "
                f"customer_id={customer_id} current_group_id={current_group_id} "
                f"variant_id={variant_id} charged={charged_unit_price} "
                f"current_group_price={current_group_unit_price} delta={price_delta}"
            )
            flagged_rows.append({
                "order_id": order_id,
                "customer_id": customer_id,
                "current_group_id": current_group_id,
                "variant_id": variant_id,
                "charged_unit_price": str(charged_unit_price),
                "current_group_unit_price": str(current_group_unit_price),
                "price_delta": str(price_delta),
            })
            log.info("%s (%s)", summary, "dry run" if DRY_RUN else "flagging")
            if not DRY_RUN:
                flag_order_note(order_id, summary)

    if flagged_rows:
        with open(OUTPUT_CSV, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(flagged_rows[0].keys()))
            writer.writeheader()
            writer.writerows(flagged_rows)

    log.info(
        "Done. %d order line(s) flagged as possibly priced against a stale customer group. %s",
        len(flagged_rows),
        f"Wrote {OUTPUT_CSV}" if flagged_rows else "",
    )


if __name__ == "__main__":
    run()
