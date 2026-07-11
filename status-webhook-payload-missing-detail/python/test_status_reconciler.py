from reconcile_order_status import diff_order_status


def order(id_=1, status_id=11, date_modified="2026-07-10T12:00:00"):
    return {"id": id_, "status_id": status_id, "date_modified": date_modified}


def test_no_local_record_is_a_mismatch():
    result = diff_order_status({}, [order(id_=1, status_id=11)])
    assert result == [{
        "order_id": 1,
        "previous_known_status_id": None,
        "current_status_id": 11,
        "date_modified": "2026-07-10T12:00:00",
    }]


def test_matching_status_is_a_no_op():
    known = {1: 11}
    result = diff_order_status(known, [order(id_=1, status_id=11)])
    assert result == []


def test_stale_status_is_a_mismatch():
    known = {1: 7}
    result = diff_order_status(known, [order(id_=1, status_id=11)])
    assert result == [{
        "order_id": 1,
        "previous_known_status_id": 7,
        "current_status_id": 11,
        "date_modified": "2026-07-10T12:00:00",
    }]


def test_empty_fetched_orders_returns_empty_list():
    assert diff_order_status({1: 11}, []) == []


def test_mixed_batch_only_flags_the_mismatches():
    known = {1: 11, 2: 7}
    fetched = [order(id_=1, status_id=11), order(id_=2, status_id=10), order(id_=3, status_id=5)]
    result = diff_order_status(known, fetched)
    order_ids = sorted(m["order_id"] for m in result)
    assert order_ids == [2, 3]
