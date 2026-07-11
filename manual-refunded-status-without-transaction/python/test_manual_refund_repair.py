from find_orphaned_refund_statuses import is_orphaned_refund_status


def refund_txn(amount="50.00", type_="refund"):
    return {"type": type_, "amount": amount}


def test_false_when_status_is_not_refund_related():
    assert is_orphaned_refund_status(10, [], "0.00", "50.00") is False


def test_true_when_refunded_status_with_no_transactions_at_all():
    assert is_orphaned_refund_status(4, [], "0.00", "50.00") is True


def test_false_when_refunded_status_has_a_real_refund_transaction():
    txns = [refund_txn(amount="50.00")]
    assert is_orphaned_refund_status(4, txns, "50.00", "50.00") is False


def test_true_when_partially_refunded_with_only_non_refund_transactions():
    txns = [{"type": "capture", "amount": "50.00"}]
    assert is_orphaned_refund_status(14, txns, "0.00", "50.00") is True


def test_false_when_refunded_amount_is_recorded_even_without_a_txn_row():
    assert is_orphaned_refund_status(4, [], "50.00", "50.00") is False


def test_true_when_refund_transaction_amount_is_zero():
    txns = [refund_txn(amount="0.00")]
    assert is_orphaned_refund_status(4, txns, "0.00", "50.00") is True


def test_uses_event_key_when_type_key_is_absent():
    txns = [{"event": "refund", "amount": "50.00"}]
    assert is_orphaned_refund_status(4, txns, "50.00", "50.00") is False


def test_non_refund_status_id_is_never_orphaned_even_with_no_transactions():
    assert is_orphaned_refund_status(7, [], "0.00", "50.00") is False
