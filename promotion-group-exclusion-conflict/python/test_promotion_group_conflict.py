from find_group_conflicts import decide_group_conflict


def test_no_conflict_when_both_lists_are_empty():
    result = decide_group_conflict([], [])
    assert result["conflict"] is False


def test_no_conflict_when_only_group_ids_is_populated():
    result = decide_group_conflict([12, 14], [])
    assert result["conflict"] is False


def test_no_conflict_when_only_excluded_group_ids_is_populated():
    result = decide_group_conflict([], [9])
    assert result["conflict"] is False


def test_conflict_when_both_lists_are_populated():
    result = decide_group_conflict([12, 14], [9])
    assert result["conflict"] is True
    assert result["reason"] == "both group_ids and excluded_group_ids populated"
    assert result["suggested_fix"] == {"clear": "excluded_group_ids"}


def test_conflict_when_guest_sentinel_zero_is_in_group_ids():
    result = decide_group_conflict([0], [9])
    assert result["conflict"] is True


def test_conflict_when_guest_sentinel_zero_is_in_excluded_group_ids():
    result = decide_group_conflict([12], [0])
    assert result["conflict"] is True
