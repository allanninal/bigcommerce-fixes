from clear_blocking_group_discounts import find_blocked_price_list_groups


def group(id_, name="Wholesale", discount_rules=None):
    return {"id": id_, "name": name, "discount_rules": discount_rules or []}


def assignment(customer_group_id, price_list_id=1, channel_id=1):
    return {"price_list_id": price_list_id, "customer_group_id": customer_group_id, "channel_id": channel_id}


def test_group_with_rules_and_assignment_is_blocked():
    groups = [group(10, discount_rules=[{"type": "product", "method": "percent", "amount": "10.000000"}])]
    assignments = [assignment(10, price_list_id=5)]
    result = find_blocked_price_list_groups(groups, assignments)
    assert result == [{
        "group_id": 10,
        "group_name": "Wholesale",
        "discount_rules": [{"type": "product", "method": "percent", "amount": "10.000000"}],
        "price_list_ids": [5],
    }]


def test_group_with_rules_but_no_assignment_is_not_blocked():
    groups = [group(11, discount_rules=[{"type": "product", "method": "percent", "amount": "10.000000"}])]
    assignments = []
    assert find_blocked_price_list_groups(groups, assignments) == []


def test_group_with_assignment_but_no_rules_is_not_blocked():
    groups = [group(12, discount_rules=[])]
    assignments = [assignment(12, price_list_id=6)]
    assert find_blocked_price_list_groups(groups, assignments) == []


def test_group_with_neither_is_not_blocked():
    groups = [group(13, discount_rules=[])]
    assignments = []
    assert find_blocked_price_list_groups(groups, assignments) == []


def test_multiple_price_lists_on_one_blocked_group_are_all_collected():
    groups = [group(14, discount_rules=[{"type": "storewide", "method": "fixed", "amount": "5.000000"}])]
    assignments = [assignment(14, price_list_id=7), assignment(14, price_list_id=8)]
    result = find_blocked_price_list_groups(groups, assignments)
    assert result[0]["price_list_ids"] == [7, 8]


def test_only_matching_group_is_flagged_among_several():
    groups = [
        group(15, discount_rules=[{"type": "product", "method": "percent", "amount": "10.000000"}]),
        group(16, discount_rules=[]),
    ]
    assignments = [assignment(15, price_list_id=9), assignment(16, price_list_id=9)]
    result = find_blocked_price_list_groups(groups, assignments)
    assert len(result) == 1
    assert result[0]["group_id"] == 15
