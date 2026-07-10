from flag_disputed_orders import needs_dispute_flag


def chargeback_txn(type_="chargeback", status="pending"):
    return {"type": type_, "status": status, "amount": "50.00", "id": 1}


def test_flags_when_transaction_type_is_chargeback():
    assert needs_dispute_flag(10, [chargeback_txn()]) is True


def test_flags_when_transaction_status_reads_disputed():
    txn = {"type": "capture", "status": "disputed", "amount": "50.00", "id": 2}
    assert needs_dispute_flag(10, [txn]) is True


def test_no_flag_when_no_dispute_marker_present():
    txn = {"type": "capture", "status": "success", "amount": "50.00", "id": 3}
    assert needs_dispute_flag(10, [txn]) is False


def test_no_flag_when_already_disputed():
    assert needs_dispute_flag(13, [chargeback_txn()]) is False


def test_no_flag_when_already_refunded():
    assert needs_dispute_flag(4, [chargeback_txn()]) is False


def test_no_flag_when_already_cancelled():
    assert needs_dispute_flag(5, [chargeback_txn()]) is False


def test_no_flag_with_no_transactions():
    assert needs_dispute_flag(10, []) is False
