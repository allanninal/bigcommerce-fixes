from link_guest_orders import decide_order_link


def order(**over):
    base = {"id": 101, "customer_id": 0, "billing_email": "jane@example.com", "status_id": 11}
    base.update(over)
    return base


def match(customer_id=555, email="jane@example.com"):
    return {"id": customer_id, "email": email}


def test_link_when_exactly_one_confident_match():
    decision = decide_order_link(order(), [match()])
    assert decision["action"] == "link"
    assert decision["targetCustomerId"] == 555


def test_link_is_case_and_whitespace_insensitive():
    decision = decide_order_link(
        order(billing_email="  Jane@Example.com  "),
        [match(email="jane@example.com")],
    )
    assert decision["action"] == "link"
    assert decision["targetCustomerId"] == 555


def test_skip_when_already_linked_to_a_customer():
    decision = decide_order_link(order(customer_id=42), [match()])
    assert decision["action"] == "skip"
    assert decision["targetCustomerId"] is None


def test_skip_when_status_incomplete():
    decision = decide_order_link(order(status_id=0), [match()])
    assert decision["action"] == "skip"


def test_skip_when_status_cancelled():
    decision = decide_order_link(order(status_id=5), [match()])
    assert decision["action"] == "skip"


def test_skip_when_status_declined():
    decision = decide_order_link(order(status_id=6), [match()])
    assert decision["action"] == "skip"


def test_flag_when_no_matches():
    decision = decide_order_link(order(), [])
    assert decision["action"] == "flag"
    assert decision["targetCustomerId"] is None


def test_flag_when_multiple_matches():
    decision = decide_order_link(order(), [match(1, "jane@example.com"), match(2, "jane@example.com")])
    assert decision["action"] == "flag"
    assert decision["targetCustomerId"] is None


def test_flag_when_email_does_not_match_exactly():
    decision = decide_order_link(order(billing_email="jane@example.com"), [match(email="j.ane@example.com")])
    assert decision["action"] == "flag"
    assert decision["targetCustomerId"] is None
