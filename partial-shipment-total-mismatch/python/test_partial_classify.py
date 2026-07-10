from find_shipment_mismatch import classify_shipment_mismatch


def test_ok_when_everything_ties_out_and_not_partial():
    assert classify_shipment_mismatch(10, 10, 0, 10, 2) == "ok"


def test_ok_when_partial_and_consistent():
    assert classify_shipment_mismatch(10, 4, 0, 4, 3) == "ok"


def test_ledger_drift_when_ledger_disagrees_with_cached_counter():
    assert classify_shipment_mismatch(10, 6, 0, 8, 3) == "ledger_drift"


def test_over_fulfilled_when_shipped_plus_refunded_exceeds_ordered():
    assert classify_shipment_mismatch(10, 8, 5, 8, 2) == "over_fulfilled"


def test_stuck_partial_done_when_fully_shipped_but_status_still_partial():
    assert classify_shipment_mismatch(10, 10, 0, 10, 3) == "stuck_partial_done"


def test_stuck_partial_unshipped_when_nothing_moved_but_status_is_partial():
    assert classify_shipment_mismatch(10, 0, 0, 0, 3) == "stuck_partial_unshipped"


def test_ledger_drift_takes_priority_over_stuck_partial_done():
    # shipped equals ordered, but the ledger itself disagrees, so drift wins
    assert classify_shipment_mismatch(10, 10, 0, 7, 3) == "ledger_drift"


def test_over_fulfilled_takes_priority_when_ledger_also_agrees():
    assert classify_shipment_mismatch(10, 9, 2, 9, 2) == "over_fulfilled"


def test_ok_when_status_is_shipped_and_everything_matches():
    assert classify_shipment_mismatch(5, 5, 0, 5, 2) == "ok"


def test_stuck_partial_unshipped_not_triggered_when_refund_present():
    # nothing shipped, but a refund exists, so this is not the "never even tried" case
    assert classify_shipment_mismatch(10, 0, 10, 0, 3) == "ok"
