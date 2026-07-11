"""Refund a BigCommerce order paid with more than one tender without tripping
"the requested refund had invalid split payment."

An order paid with more than one tender, part gift card and part credit card, or
store credit plus PayPal, settles as separate transactions against separate
payment providers, each capped at what that provider actually captured. The V3
refund endpoint, POST /v3/orders/{order_id}/payment_actions/refunds, requires the
payments[].provider_id and payments[].amount in the request to exactly match an
entry the gateway already approved in a prior refund quote from
POST /v3/orders/{order_id}/payment_actions/refund_quotes. It will not
automatically split a lump sum refund across tenders. This script always
requests the quote first, builds the payments array from the quote's own
refund_methods, and only then posts the refund. Safe to run again and again.

Guide: https://www.allanninal.dev/bigcommerce/refund-invalid-split-payment/
"""
import os
import logging
from decimal import Decimal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("refund_split_payment")

STORE_HASH = os.environ.get("BIGCOMMERCE_STORE_HASH", "example_hash")
ACCESS_TOKEN = os.environ.get("BIGCOMMERCE_ACCESS_TOKEN", "example_token")
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


def build_split_refund_payload(refund_quote: dict, requested_total: str) -> list:
    """Pure decision. No network, no side effects.

    Takes refund_quote["refund_methods"] (a list of {"provider_id", "amount"}
    entries as returned by POST .../refund_quotes) and the Decimal-string
    requested_total. Returns a list of {"provider_id", "amount"} entries such
    that:

      (a) no entry's amount exceeds that method's quoted max,
      (b) entries are ordered by provider_id for determinism,
      (c) entries' amounts sum exactly to requested_total (raises ValueError
          if requested_total exceeds the sum of all refund_methods amounts,
          i.e. an over-refund attempt), and
      (d) raises ValueError if requested_total is zero/negative or
          refund_methods is empty.

    Multi vs single tender is simply len(refund_methods) > 1, handled
    naturally by this same loop; no special casing needed.
    """
    methods = sorted(
        refund_quote.get("refund_methods") or [],
        key=lambda m: m["provider_id"],
    )
    if not methods:
        raise ValueError("refund_quote has no refund_methods to split across")

    total = Decimal(str(requested_total))
    if total <= 0:
        raise ValueError("requested_total must be greater than zero")

    available_total = sum(Decimal(str(m["amount"])) for m in methods)
    if total > available_total:
        raise ValueError(
            f"requested_total {total} exceeds available refund amount {available_total}"
        )

    remaining = total
    payload = []
    for method in methods:
        if remaining <= 0:
            break
        max_amount = Decimal(str(method["amount"]))
        take = min(max_amount, remaining)
        payload.append({"provider_id": method["provider_id"], "amount": str(take)})
        remaining -= take

    return payload


def request_refund_quote(order_id, quote_payload):
    return bc_post(f"/orders/{order_id}/payment_actions/refund_quotes", quote_payload)


def post_refund(order_id, payments):
    return bc_post(f"/orders/{order_id}/payment_actions/refunds", {"payments": payments})


def refund_order(order_id, quote_payload, requested_total):
    """Quote, split, and (if not a dry run) post the refund for one order.

    One order, one refund call at a time: BigCommerce does not support
    concurrent refunds on the same order, so this is not parallelized across
    orders and should not be called concurrently for the same order_id.
    """
    quote_response = request_refund_quote(order_id, quote_payload)
    refund_quote = quote_response.get("data", quote_response)

    payments = build_split_refund_payload(refund_quote, requested_total)

    log.info(
        "order_id=%s requested_total=%s split=%s (%s)",
        order_id, requested_total, payments, "dry run" if DRY_RUN else "posting",
    )

    if DRY_RUN:
        return {"order_id": order_id, "payments": payments, "posted": False}

    result = post_refund(order_id, payments)
    return {"order_id": order_id, "payments": payments, "posted": True, "result": result}


def run():
    order_id = os.environ.get("ORDER_ID", "0")
    requested_total = os.environ.get("REQUESTED_TOTAL", "0.00")
    outcome = refund_order(order_id, {"reason": "Customer request"}, requested_total)
    log.info("Done. order_id=%s posted=%s", outcome["order_id"], outcome["posted"])
    return outcome


if __name__ == "__main__":
    run()
