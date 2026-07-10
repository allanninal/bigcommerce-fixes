from fix_price_list_assignment import decide_reassignment


GROUP = {"id": 7, "name": "Wholesale"}
PRICE_LIST = {"id": 42, "active": True}
CHANNELS = [1, 2]


def test_create_assignment_when_none_exists():
    decision = decide_reassignment(GROUP, PRICE_LIST, [], CHANNELS, [], [])
    assert decision == {
        "action": "CREATE_ASSIGNMENT",
        "priceListId": 42,
        "customerGroupId": 7,
        "channelId": 1,
    }


def test_fix_channel_when_assignment_on_wrong_channel():
    assignments = [{"id": 900, "price_list_id": 42, "customer_group_id": 7, "channel_id": 99}]
    decision = decide_reassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [], [])
    assert decision == {
        "action": "FIX_CHANNEL",
        "assignmentId": 900,
        "fromChannelId": 99,
        "toChannelId": 1,
    }


def test_flag_missing_records_when_assignment_correct_but_sparse():
    assignments = [{"id": 901, "price_list_id": 42, "customer_group_id": 7, "channel_id": 1}]
    decision = decide_reassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [501, 502], [501])
    assert decision == {"action": "FLAG_MISSING_RECORDS", "priceListId": 42, "missingVariantIds": [502]}


def test_none_when_fully_healthy():
    assignments = [{"id": 902, "price_list_id": 42, "customer_group_id": 7, "channel_id": 1}]
    decision = decide_reassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [501, 502], [501, 502])
    assert decision == {"action": "NONE"}


def test_none_when_no_active_price_list():
    decision = decide_reassignment(GROUP, None, [], CHANNELS, [], [])
    assert decision == {"action": "NONE"}
    decision = decide_reassignment(GROUP, {"id": 42, "active": False}, [], CHANNELS, [], [])
    assert decision == {"action": "NONE"}


def test_multiple_group_assignments_ignores_other_groups():
    assignments = [
        {"id": 800, "price_list_id": 42, "customer_group_id": 99, "channel_id": 1},
        {"id": 901, "price_list_id": 42, "customer_group_id": 7, "channel_id": 1},
    ]
    decision = decide_reassignment(GROUP, PRICE_LIST, assignments, CHANNELS, [], [])
    assert decision == {"action": "NONE"}
