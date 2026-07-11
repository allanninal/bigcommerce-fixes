from confirm_inventory_write import confirm_inventory_write


def test_confirmed_when_observed_matches_expected():
    result = confirm_inventory_write(50, 50, "adj_1", 0, 6)
    assert result["status"] == "confirmed"


def test_stale_flagged_when_adjustment_id_missing():
    result = confirm_inventory_write(50, 40, None, 0, 6)
    assert result["status"] == "stale_flagged"
    assert result["reason"] == "missing action id, cannot confirm"


def test_retry_when_not_matching_and_budget_remains():
    result = confirm_inventory_write(50, 40, "adj_1", 0, 6)
    assert result["status"] == "retry"
    assert result["next_delay_s"] == 1.0


def test_retry_delay_doubles_each_attempt():
    result = confirm_inventory_write(50, 40, "adj_1", 2, 6)
    assert result["next_delay_s"] == 4.0


def test_retry_delay_caps_at_max_delay():
    result = confirm_inventory_write(50, 40, "adj_1", 10, 20, base_delay_s=1.0, max_delay_s=60.0)
    assert result["next_delay_s"] == 60.0


def test_stale_flagged_when_budget_exhausted():
    result = confirm_inventory_write(50, 40, "adj_1", 6, 6)
    assert result["status"] == "stale_flagged"
    assert result["reason"] == "poll budget exhausted"


def test_confirmed_takes_priority_even_at_final_attempt():
    result = confirm_inventory_write(50, 50, "adj_1", 6, 6)
    assert result["status"] == "confirmed"


def test_zero_expected_quantity_can_confirm():
    result = confirm_inventory_write(0, 0, "adj_1", 0, 6)
    assert result["status"] == "confirmed"
