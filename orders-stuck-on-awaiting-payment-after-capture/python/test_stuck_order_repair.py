from advance_captured_orders import decide_order_repair


def capture_txn(amount="50.00", type_="capture", status="success"):
    return {"type": type_, "status": status, "amount": amount, "gateway": "test_gateway",
            "gateway_transaction_id": "gw_123", "id": 1}


def test_no_action_when_status_is_not_awaiting_payment():
    assert decide_order_repair(11, [capture_txn()], "50.00") == "no_action"


def test_advance_when_successful_capture_matches_total():
    assert decide_order_repair(7, [capture_txn(amount="50.00")], "50.00") == "advance_to_awaiting_fulfillment"


def test_advance_when_successful_sale_matches_total():
    assert decide_order_repair(7, [capture_txn(type_="sale", amount="50.00")], "50.00") == "advance_to_awaiting_fulfillment"


def test_no_action_when_no_capture_type_transaction_exists():
    txns = [{"type": "authorization", "status": "success", "amount": "50.00"}]
    assert decide_order_repair(7, txns, "50.00") == "no_action"


def test_no_action_when_transactions_empty():
    assert decide_order_repair(7, [], "50.00") == "no_action"


def test_flag_for_review_when_capture_is_pending():
    assert decide_order_repair(7, [capture_txn(status="pending")], "50.00") == "flag_for_review"


def test_flag_for_review_when_capture_is_declined():
    assert decide_order_repair(7, [capture_txn(status="declined")], "50.00") == "flag_for_review"


def test_flag_for_review_when_amount_does_not_match():
    assert decide_order_repair(7, [capture_txn(amount="40.00")], "50.00") == "flag_for_review"


def test_advance_when_one_matching_success_alongside_a_declined_one():
    txns = [capture_txn(status="declined", amount="50.00"), capture_txn(status="success", amount="50.00")]
    assert decide_order_repair(7, txns, "50.00") == "advance_to_awaiting_fulfillment"


def test_amount_epsilon_allows_tiny_float_drift():
    assert decide_order_repair(7, [capture_txn(amount="50.004")], "50.00") == "advance_to_awaiting_fulfillment"


def test_amount_epsilon_rejects_real_mismatch():
    assert decide_order_repair(7, [capture_txn(amount="50.50")], "50.00") == "flag_for_review"
