from write_order_status_id import resolve_status_id

STATUS_MAP = {
    "incomplete": 0, "pending": 1, "shipped": 2, "partially shipped": 3,
    "refunded": 4, "cancelled": 5, "declined": 6, "awaiting payment": 7,
    "awaiting pickup": 8, "awaiting shipment": 9, "completed": 10,
    "awaiting fulfillment": 11, "manual verification required": 12,
    "disputed": 13, "partially refunded": 14,
}


def test_resolves_valid_int_status_id():
    assert resolve_status_id(2, STATUS_MAP) == 2


def test_rejects_out_of_range_int_status_id():
    assert resolve_status_id(999, STATUS_MAP) is None


def test_rejects_negative_int_status_id():
    assert resolve_status_id(-1, STATUS_MAP) is None


def test_resolves_case_insensitive_name():
    assert resolve_status_id("Shipped", STATUS_MAP) == 2
    assert resolve_status_id("  shipped  ", STATUS_MAP) == 2


def test_resolves_numeric_string():
    assert resolve_status_id("11", STATUS_MAP) == 11


def test_unknown_name_returns_none_not_the_string():
    result = resolve_status_id("Shipped Today", STATUS_MAP)
    assert result is None
    assert not isinstance(result, str)


def test_boolean_is_never_treated_as_valid_status_id():
    assert resolve_status_id(True, STATUS_MAP) is None
    assert resolve_status_id(False, STATUS_MAP) is None


def test_custom_label_resolves_when_present_in_map():
    custom_map = dict(STATUS_MAP)
    custom_map["ready to pack"] = 11
    assert resolve_status_id("Ready to Pack", custom_map) == 11


def test_none_desired_returns_none():
    assert resolve_status_id(None, STATUS_MAP) is None
