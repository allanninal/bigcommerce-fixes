from price_list_variant_gaps import find_variant_price_gaps


def test_variant_present_in_both_shows_no_gap():
    active_variant_ids = {1, 2}
    records = [{"variant_id": 1}, {"variant_id": 2}]
    group_to_price_list = {10: 500}
    assert find_variant_price_gaps(active_variant_ids, records, group_to_price_list) == []


def test_variant_missing_from_records_is_reported():
    active_variant_ids = {1, 2, 3}
    records = [{"variant_id": 1}, {"variant_id": 2}]
    group_to_price_list = {10: 500}
    result = find_variant_price_gaps(active_variant_ids, records, group_to_price_list)
    assert result == [
        {"price_list_id": 500, "variant_id": 3, "affected_customer_groups": [10]}
    ]


def test_multiple_groups_on_same_price_list_are_all_listed():
    active_variant_ids = {3}
    records = []
    group_to_price_list = {10: 500, 20: 500}
    result = find_variant_price_gaps(active_variant_ids, records, group_to_price_list)
    assert len(result) == 1
    assert set(result[0]["affected_customer_groups"]) == {10, 20}


def test_results_are_sorted_by_variant_id():
    active_variant_ids = {3, 1, 2}
    records = []
    group_to_price_list = {10: 500}
    result = find_variant_price_gaps(active_variant_ids, records, group_to_price_list)
    assert [r["variant_id"] for r in result] == [1, 2, 3]


def test_no_gaps_when_no_active_variants():
    assert find_variant_price_gaps(set(), [], {10: 500}) == []


def test_gap_reported_separately_per_distinct_price_list():
    active_variant_ids = {7}
    records = []
    group_to_price_list = {10: 500, 20: 600}
    result = find_variant_price_gaps(active_variant_ids, records, group_to_price_list)
    price_list_ids = {r["price_list_id"] for r in result}
    assert price_list_ids == {500, 600}


def test_no_gap_reported_for_price_lists_with_no_group_assignment():
    active_variant_ids = {1, 2}
    records = []
    group_to_price_list = {}
    assert find_variant_price_gaps(active_variant_ids, records, group_to_price_list) == []
