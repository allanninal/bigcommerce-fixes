from reconcile_incomplete_orders import decide_order_repair


def txn(type="purchase", status="success", gateway_transaction_id="gw_123"):
    return {"type": type, "status": status, "gateway_transaction_id": gateway_transaction_id}


def test_no_action_when_status_is_not_incomplete():
    assert decide_order_repair(11, [txn()]) == "no_action"


def test_no_action_when_no_charge_transactions():
    assert decide_order_repair(0, []) == "no_action"
    assert decide_order_repair(0, [txn(type="void")]) == "no_action"


def test_no_action_when_only_pending_or_declined():
    pending = txn(status="pending", gateway_transaction_id=None)
    declined = txn(status="declined")
    assert decide_order_repair(0, [pending]) == "no_action"
    assert decide_order_repair(0, [declined]) == "no_action"


def test_advance_when_successful_capture_with_no_conflict():
    assert decide_order_repair(0, [txn()]) == "advance_to_awaiting_fulfillment"
    assert decide_order_repair(0, [txn(type="capture")]) == "advance_to_awaiting_fulfillment"


def test_advance_ignores_unrelated_transaction_types():
    success = txn()
    other = {"type": "refund", "status": "success", "gateway_transaction_id": "gw_999"}
    assert decide_order_repair(0, [success, other]) == "advance_to_awaiting_fulfillment"


def test_flag_for_review_when_success_conflicts_with_void():
    success = txn()
    void = txn(type="void", status="success", gateway_transaction_id="gw_456")
    assert decide_order_repair(0, [success, void]) == "flag_for_review"


def test_flag_for_review_when_success_conflicts_with_declined():
    success = txn()
    declined = txn(status="declined")
    assert decide_order_repair(0, [success, declined]) == "flag_for_review"


def test_no_action_when_success_missing_gateway_transaction_id():
    incomplete_success = txn(gateway_transaction_id=None)
    assert decide_order_repair(0, [incomplete_success]) == "no_action"


def test_advance_when_approved_status_used_instead_of_success():
    assert decide_order_repair(0, [txn(status="approved")]) == "advance_to_awaiting_fulfillment"
