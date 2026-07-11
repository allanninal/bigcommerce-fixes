from reconcile_order_counts import reconcile_order_counts


def test_is_consistent_when_every_bucket_matches():
    counts = {0: 3, 1: 5, 2: 2}
    paginated = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2]
    report = reconcile_order_counts(counts, paginated)
    assert report.is_consistent is True
    assert report.mismatched_status_ids == []
    assert report.total_count_endpoint == 10
    assert report.total_paginated == 10


def test_flags_status_id_zero_when_incomplete_orders_are_missing_from_count():
    counts = {0: 0, 1: 5}  # count endpoint excluded Incomplete orders
    paginated = [0, 0, 1, 1, 1, 1, 1]  # pagination still saw them
    report = reconcile_order_counts(counts, paginated)
    assert report.is_consistent is False
    assert report.mismatched_status_ids == [0]
    assert report.per_status_deltas[0] == -2
    assert report.per_status_deltas[1] == 0


def test_handles_status_id_present_only_in_pagination():
    counts = {1: 2}
    paginated = [1, 1, 5]
    report = reconcile_order_counts(counts, paginated)
    assert report.mismatched_status_ids == [5]
    assert report.per_status_deltas[5] == -1


def test_handles_status_id_present_only_in_count_endpoint():
    counts = {1: 2, 9: 4}
    paginated = [1, 1]
    report = reconcile_order_counts(counts, paginated)
    assert report.mismatched_status_ids == [9]
    assert report.per_status_deltas[9] == 4


def test_empty_inputs_are_consistent():
    report = reconcile_order_counts({}, [])
    assert report.is_consistent is True
    assert report.total_count_endpoint == 0
    assert report.total_paginated == 0


def test_all_fifteen_status_ids_can_be_reconciled_at_once():
    counts = {sid: 1 for sid in range(15)}
    paginated = list(range(15))
    report = reconcile_order_counts(counts, paginated)
    assert report.is_consistent is True
    assert report.total_count_endpoint == 15
    assert report.total_paginated == 15


def test_multiple_mismatched_buckets_are_all_reported():
    counts = {0: 5, 1: 2, 2: 0}
    paginated = [0, 0, 1, 1, 1, 2, 2, 2]
    report = reconcile_order_counts(counts, paginated)
    assert sorted(report.mismatched_status_ids) == [0, 1, 2]
    assert report.per_status_deltas[0] == 3
    assert report.per_status_deltas[1] == -1
    assert report.per_status_deltas[2] == -3
