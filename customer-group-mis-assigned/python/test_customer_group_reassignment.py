from fix_customer_group import decide_group_reassignment


EMAIL_DOMAIN_RULE = {
    "matchType": "email_domain",
    "pattern": "wholesale-buyer.example",
    "targetGroupId": 3,
    "fallbackGroupId": 0,
}

SPEND_RULE = {
    "matchType": "spend_threshold",
    "thresholdCents": 500000,
    "targetGroupId": 5,
    "fallbackGroupId": 0,
}


def customer(**over):
    base = {"id": 101, "customer_group_id": 0, "email": "buyer@retail.example"}
    base.update(over)
    return base


def test_domain_match_needs_reassignment():
    decision = decide_group_reassignment(customer(email="ana@wholesale-buyer.example"), EMAIL_DOMAIN_RULE)
    assert decision["needsReassignment"] is True
    assert decision["expectedGroupId"] == 3
    assert decision["currentGroupId"] == 0


def test_domain_no_match_falls_back_and_already_correct():
    decision = decide_group_reassignment(customer(customer_group_id=0), EMAIL_DOMAIN_RULE)
    assert decision["needsReassignment"] is False
    assert decision["expectedGroupId"] == 0


def test_spend_threshold_match():
    c = customer(total_lifetime_spend_cents=600000, customer_group_id=0)
    decision = decide_group_reassignment(c, SPEND_RULE)
    assert decision["needsReassignment"] is True
    assert decision["expectedGroupId"] == 5


def test_spend_missing_field_defaults_to_fallback():
    c = customer(customer_group_id=5)
    decision = decide_group_reassignment(c, SPEND_RULE)
    assert decision["expectedGroupId"] == 0
    assert decision["needsReassignment"] is True


def test_already_correct_group_needs_no_reassignment():
    c = customer(email="ana@wholesale-buyer.example", customer_group_id=3)
    decision = decide_group_reassignment(c, EMAIL_DOMAIN_RULE)
    assert decision == {
        "customerId": 101,
        "currentGroupId": 3,
        "expectedGroupId": 3,
        "needsReassignment": False,
        "reason": "email domain 'wholesale-buyer.example' matches 'wholesale-buyer.example'; already in the correct group 3",
    }


def test_unknown_match_type_defaults_to_fallback():
    rule = {"matchType": "mystery", "targetGroupId": 9, "fallbackGroupId": 2}
    decision = decide_group_reassignment(customer(customer_group_id=2), rule)
    assert decision["needsReassignment"] is False
    assert decision["expectedGroupId"] == 2


def test_tax_exempt_match():
    rule = {"matchType": "tax_exempt", "targetGroupId": 8, "fallbackGroupId": 0}
    decision = decide_group_reassignment(customer(tax_exempt_category="wholesale", customer_group_id=0), rule)
    assert decision["needsReassignment"] is True
    assert decision["expectedGroupId"] == 8


def test_source_tag_match():
    rule = {"matchType": "source_tag", "pattern": "b2b-portal", "targetGroupId": 6, "fallbackGroupId": 0}
    decision = decide_group_reassignment(customer(registration_source="b2b-portal", customer_group_id=0), rule)
    assert decision["needsReassignment"] is True
    assert decision["expectedGroupId"] == 6
