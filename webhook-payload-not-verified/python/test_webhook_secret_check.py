from verify_webhook_secret import classify_webhook_request


def hook(**over):
    base = {"headers": {"X-Webhook-Secret": "correct-secret"}}
    base.update(over)
    return base


def incoming(**over):
    base = {"headers": {"X-Webhook-Secret": "correct-secret"}, "secretKeyName": "X-Webhook-Secret", "mutationRanBeforeCheck": False}
    base.update(over)
    return base


def test_unverifiable_when_hook_has_no_headers():
    assert classify_webhook_request({}, incoming()) == "UNVERIFIABLE_NO_SECRET"


def test_unverifiable_when_hook_headers_empty():
    assert classify_webhook_request(hook(headers={}), incoming()) == "UNVERIFIABLE_NO_SECRET"


def test_reject_when_header_missing_from_request():
    req = incoming(headers={})
    assert classify_webhook_request(hook(), req) == "REJECT_MISMATCH"


def test_reject_when_header_value_wrong():
    req = incoming(headers={"X-Webhook-Secret": "forged-value"})
    assert classify_webhook_request(hook(), req) == "REJECT_MISMATCH"


def test_reject_when_mutation_ran_before_check():
    req = incoming(mutationRanBeforeCheck=True)
    assert classify_webhook_request(hook(), req) == "REJECT_USED_BEFORE_CHECK"


def test_trusted_when_match_and_checked_first():
    assert classify_webhook_request(hook(), incoming()) == "TRUSTED"
