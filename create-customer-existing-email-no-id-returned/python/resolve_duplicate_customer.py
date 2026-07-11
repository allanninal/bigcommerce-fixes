"""Resolve the real customer_id when POST /v3/customers rejects an existing email.

BigCommerce enforces email uniqueness for customer records at the database
layer. When POST /v3/customers is called with an email that already belongs
to a customer, the API rejects the whole batch atomically with a 422
validation error ("The email address ... is already in use by a customer."),
but the error payload only has the validation message and field, never the
conflicting customer's id. Because the batch is submitted as an array, the
response also does not say which submitted email collided. This script
catches that 422, classifies it with a pure decision function, and resolves
the real id for each candidate email with GET /v3/customers?email:in={email}.
This is not a data repair scenario, there is no bad state to fix, it is a
flag and resolve workflow. Only if DRY_RUN is false and the caller explicitly
wants an upsert does it PUT the existing record instead of leaving it alone.

Guide: https://www.allanninal.dev/bigcommerce/create-customer-existing-email-no-id-returned/
"""
import os
import re
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resolve_duplicate_customer")

STORE_HASH = os.environ["BIGCOMMERCE_STORE_HASH"]
ACCESS_TOKEN = os.environ["BIGCOMMERCE_ACCESS_TOKEN"]
API_BASE = f"https://api.bigcommerce.com/stores/{STORE_HASH}/v3"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ALREADY_IN_USE_RE = re.compile(r"already in use", re.IGNORECASE)

HEADERS = {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def bc_post(path, body):
    r = requests.post(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    return r.status_code, (r.json() if r.text else {})


def bc_get(path, params=None):
    r = requests.get(f"{API_BASE}{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {"data": []}


def bc_put(path, body):
    r = requests.put(f"{API_BASE}{path}", headers=HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else {}


def resolve_duplicate_customer_action(create_response: dict, submitted_emails: list) -> dict:
    """Pure decision. No network, no side effects.

    Given the parsed JSON body of a failed POST /v3/customers response (with
    .status, .title, .errors) and the list of emails submitted in that batch,
    decide whether this is an "email already in use" collision (regex match on
    title/errors messages) and which submitted email(s) are lookup candidates,
    since the response itself never names them. Returns
    {"is_duplicate_email_error": bool, "candidate_emails": [...],
    "next_action": "lookup_by_email" | "raise"}.
    """
    status = create_response.get("status")
    title = create_response.get("title") or ""
    errors = create_response.get("errors") or {}

    messages = [title]
    if isinstance(errors, dict):
        messages.extend(str(v) for v in errors.values())
    elif isinstance(errors, list):
        for e in errors:
            if isinstance(e, dict):
                messages.append(str(e.get("message", "")))
            else:
                messages.append(str(e))

    is_duplicate = status == 422 and any(
        ALREADY_IN_USE_RE.search(m) for m in messages if m
    )

    if is_duplicate:
        return {
            "is_duplicate_email_error": True,
            "candidate_emails": list(submitted_emails),
            "next_action": "lookup_by_email",
        }
    return {
        "is_duplicate_email_error": False,
        "candidate_emails": [],
        "next_action": "raise",
    }


def create_customers(customer_payloads):
    status, body = bc_post("/customers", customer_payloads)
    submitted_emails = [c["email"] for c in customer_payloads if c.get("email")]
    return status, body, submitted_emails


def resolve_customer_id_by_email(email):
    body = bc_get("/customers", {"email:in": email, "include": "storecredit,attributes"})
    data = body.get("data") or []
    return data[0]["id"] if data else None


def upsert_customer(customer_id, fields):
    payload = dict(fields)
    payload["id"] = customer_id
    return bc_put("/customers", [payload])


def run(customer_payloads, upsert_fields=None):
    status, body, submitted_emails = create_customers(customer_payloads)

    if status in (200, 201):
        log.info("Created %d customer(s).", len(body.get("data", [])))
        return

    create_response = {"status": status, "title": body.get("title"), "errors": body.get("errors")}
    decision = resolve_duplicate_customer_action(create_response, submitted_emails)

    if not decision["is_duplicate_email_error"]:
        raise RuntimeError(f"BigCommerce create failed: status={status} body={body}")

    for email in decision["candidate_emails"]:
        resolved_id = resolve_customer_id_by_email(email)
        if resolved_id is None:
            log.warning("email=%s flagged as duplicate but no matching customer found.", email)
            continue

        log.info("email=%s resolved_customer_id=%s", email, resolved_id)

        if not DRY_RUN and upsert_fields is not None:
            upsert_customer(resolved_id, upsert_fields)
            log.info("email=%s customer_id=%s updated via PUT /v3/customers", email, resolved_id)


if __name__ == "__main__":
    run([{"email": "shopper@example.com", "first_name": "Jamie", "last_name": "Rivera"}])
