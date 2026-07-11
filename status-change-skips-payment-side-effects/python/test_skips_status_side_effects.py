from find_status_without_payment_action import find_status_without_payment_action


def order(status_id, payment_status="captured"):
    return {"id": 101, "status_id": status_id, "payment_status": payment_status}


def txn(type_, status="ok"):
    return {"type": type_, "status": status}


def test_refunded_order_with_ok_refund_is_consistent():
    assert find_status_without_payment_action(order(4), [txn("auth"), txn("capture"), txn("refund")]) is None


def test_refunded_order_with_no_refund_transaction_is_flagged():
    assert find_status_without_payment_action(order(4), [txn("auth"), txn("capture")]) == "MISSING_REFUND"


def test_partially_refunded_order_with_no_refund_transaction_is_flagged():
    assert find_status_without_payment_action(order(14), [txn("auth"), txn("capture")]) == "MISSING_REFUND"


def test_cancelled_order_authorize_only_with_no_void_is_flagged():
    assert find_status_without_payment_action(order(5), [txn("auth")]) == "MISSING_VOID"


def test_cancelled_order_authorize_only_with_void_is_consistent():
    assert find_status_without_payment_action(order(5), [txn("auth"), txn("void")]) is None


def test_cancelled_order_with_no_transactions_at_all_needs_no_void():
    assert find_status_without_payment_action(order(5), []) is None


def test_cancelled_order_authorized_and_captured_is_not_a_void_case():
    assert find_status_without_payment_action(order(5), [txn("auth"), txn("capture")]) is None


def test_shipped_order_authorize_only_never_captured_is_flagged():
    assert find_status_without_payment_action(order(2), [txn("auth")]) == "MISSING_CAPTURE"


def test_completed_order_with_ok_capture_is_consistent():
    assert find_status_without_payment_action(order(10), [txn("auth"), txn("capture")]) is None


def test_awaiting_fulfillment_order_with_purchase_transaction_is_consistent():
    assert find_status_without_payment_action(order(11), [txn("purchase")]) is None


def test_pending_or_declined_transactions_do_not_count_as_the_side_effect():
    txns = [txn("auth"), txn("refund", status="pending")]
    assert find_status_without_payment_action(order(4), txns) == "MISSING_REFUND"


def test_status_id_with_no_implication_is_always_consistent():
    assert find_status_without_payment_action(order(1), []) is None
