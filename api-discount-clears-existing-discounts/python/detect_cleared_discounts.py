"""Detect BigCommerce checkouts where an API discount call cleared existing discounts.

POST /v3/checkouts/{checkoutId}/discounts treats manual discounts as a full
replacement set, not an additive list. Per BigCommerce's own documentation,
calling this endpoint clears out all existing discounts applied to line
items, including product- and order-based discounts. A script or integration
that posts a new API discount to add a promo therefore silently wipes any
coupon discount, automatic promotion, or prior manual discount already
reflected on the cart or order, with no merge and no warning in the response
body. Because checkout discounts operate on the pre-order checkout resource,
not the immutable /v2/orders/{id}, the loss happens upstream of order
creation, so the placed order already reflects the wrong total with no audit
trail pointing to the call that caused it.

This job snapshots a checkout's discount and coupon state before and after
any discount POST, diffs the two snapshots with a pure, decimal-safe
function, and emits a DRY_RUN guarded report for every affected checkout. It
never silently re-applies a merged discount list, because the original
coupon's validity window, usage counters, and tax recalculation cannot be
reliably reconstructed client-side.

Guide: https://www.allanninal.dev/bigcommerce/api-discount-clears-existing-discounts/
"""
import os
import logging
from decimal import Decimal, InvalidOperation

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_cleared_discounts")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def _to_decimal(value):
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        return Decimal("0")


def diff_discount_state(before: dict, after: dict) -> dict:
    """Pure comparison of two snapshot objects. No I/O.

    before / after shape: {discountIds: list[str], couponCodes: list[str],
    totalDiscountedAmount: str}.

    Computes the set difference of discountIds and couponCodes, before minus
    after, and the totalDelta using decimal-safe subtraction rather than
    float parsing, since money is a decimal string. isAffected is true when
    either lost list is non-empty, or the total delta shows the discounted
    amount decreased beyond what the newly intended discount explains (the
    caller is expected to have already netted out the intended discount from
    totalDiscountedAmount before calling this, or to interpret a positive
    totalDelta alongside a non-empty lost list as the signal).
    """
    before_ids = before.get("discountIds") or []
    after_ids = set(after.get("discountIds") or [])
    before_codes = before.get("couponCodes") or []
    after_codes = set(after.get("couponCodes") or [])

    lost_discount_ids = [d for d in before_ids if d not in after_ids]
    lost_coupon_codes = [c for c in before_codes if c not in after_codes]

    before_total = _to_decimal(before.get("totalDiscountedAmount"))
    after_total = _to_decimal(after.get("totalDiscountedAmount"))
    total_delta = before_total - after_total

    is_affected = bool(lost_discount_ids) or bool(lost_coupon_codes)

    return {
        "lostDiscountIds": lost_discount_ids,
        "lostCouponCodes": lost_coupon_codes,
        "totalDelta": str(total_delta),
        "isAffected": is_affected,
    }


def snapshot_checkout_discount_state(checkout_id):
    checkout = bc_get(f"/checkouts/{checkout_id}")
    coupons_resp = bc_get(f"/checkouts/{checkout_id}/coupons")

    data = checkout.get("data") or {}
    cart = data.get("cart") or {}
    discount_ids = [str(d.get("id")) for d in cart.get("discounts") or []]
    coupon_codes = [c.get("code") for c in (coupons_resp.get("data") or []) if c.get("code")]
    grand_total = str(data.get("grand_total", "0"))

    return {
        "discountIds": discount_ids,
        "couponCodes": coupon_codes,
        "totalDiscountedAmount": grand_total,
    }


def apply_discount(checkout_id, discounts):
    """Applies a discount POST. Callers must bracket this with snapshots."""
    return bc_post(f"/checkouts/{checkout_id}/discounts", {"discounts": discounts})


def build_affected_report(checkout_id, cart_id, order_id, before, after, diff):
    return {
        "checkout_id": checkout_id,
        "cart_id": cart_id,
        "order_id_if_created": order_id,
        "discounts_before": before["discountIds"],
        "coupons_before": before["couponCodes"],
        "discounts_after": after["discountIds"],
        "coupons_after": after["couponCodes"],
        "total_delta": diff["totalDelta"],
    }


def check_checkout(checkout_id, cart_id, new_discounts, order_id=None):
    """Snapshot, apply, snapshot, diff. Returns the affected report or None."""
    before = snapshot_checkout_discount_state(checkout_id)

    if DRY_RUN:
        log.info("DRY_RUN: would POST discounts %s to checkout %s", new_discounts, checkout_id)
    else:
        apply_discount(checkout_id, new_discounts)

    after = snapshot_checkout_discount_state(checkout_id)
    diff = diff_discount_state(before, after)

    if not diff["isAffected"]:
        return None

    report = build_affected_report(checkout_id, cart_id, order_id, before, after, diff)
    log.warning(
        "Checkout %s affected. lost_discount_ids=%s lost_coupon_codes=%s total_delta=%s",
        checkout_id, diff["lostDiscountIds"], diff["lostCouponCodes"], diff["totalDelta"],
    )
    return report


def run(checkout_id, cart_id, new_discounts, order_id=None):
    report = check_checkout(checkout_id, cart_id, new_discounts, order_id)
    if report is None:
        log.info("Checkout %s: no discounts or coupons lost.", checkout_id)
    else:
        log.info("Affected checkout report: %s", report)
    return report


if __name__ == "__main__":
    checkout_id = os.environ.get("CHECKOUT_ID", "")
    cart_id = os.environ.get("CART_ID", "")
    if checkout_id and cart_id:
        run(checkout_id, cart_id, [{"discount_type": "manual", "amount": "10.00"}])
    else:
        log.info("Set CHECKOUT_ID and CART_ID to run this against a real checkout.")
