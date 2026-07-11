from reconcile_variant_inventory_graphql import diff_variant_stock


def test_in_sync_when_values_match():
    assert diff_variant_stock(10, 10, 5, 0) == {"status": "in_sync", "delta": 0}


def test_transient_on_first_mismatch():
    result = diff_variant_stock(12, 4, 5, 0)
    assert result == {"status": "transient", "delta": 8}


def test_transient_below_min_stable_polls():
    result = diff_variant_stock(12, 4, 5, 1, min_stable_polls=2)
    assert result == {"status": "transient", "delta": 8}


def test_flag_once_min_stable_polls_reached():
    result = diff_variant_stock(12, 4, 5, 2, min_stable_polls=2)
    assert result == {"status": "flag", "delta": 8}


def test_flag_when_graphql_reports_none_and_stable():
    result = diff_variant_stock(None, 7, 5, 2, min_stable_polls=2)
    assert result == {"status": "flag", "delta": 7}


def test_negative_delta_when_graphql_overreports():
    result = diff_variant_stock(2, 9, 5, 2, min_stable_polls=2)
    assert result == {"status": "flag", "delta": -7}


def test_zero_stock_both_sides_is_in_sync():
    result = diff_variant_stock(0, 0, 0, 0)
    assert result == {"status": "in_sync", "delta": 0}


def test_min_stable_polls_default_is_two():
    assert diff_variant_stock(12, 4, 5, 1)["status"] == "transient"
    assert diff_variant_stock(12, 4, 5, 2)["status"] == "flag"
