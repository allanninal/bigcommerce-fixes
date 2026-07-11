from flag_missing_shipping_addresses import classify_shipping_address_gap


def test_digital_only_order_with_no_address_is_ok():
    assert classify_shipping_address_gap(11, ["digital"], False) == "ok_digital_only"


def test_mixed_cart_with_no_address_is_ok_digital_only_when_no_physical_present():
    assert classify_shipping_address_gap(11, ["digital", "digital"], False) == "ok_digital_only"


def test_order_with_address_is_ok_regardless_of_line_items():
    assert classify_shipping_address_gap(11, ["digital"], True) == "ok_has_address"
    assert classify_shipping_address_gap(11, ["physical"], True) == "ok_has_address"


def test_excluded_status_is_inconclusive_even_with_physical_item():
    assert classify_shipping_address_gap(0, ["physical"], False) == "ok_excluded_status"
    assert classify_shipping_address_gap(5, ["physical"], False) == "ok_excluded_status"
    assert classify_shipping_address_gap(6, ["physical"], False) == "ok_excluded_status"


def test_physical_item_with_no_address_on_real_status_is_anomaly():
    assert classify_shipping_address_gap(11, ["physical"], False) == "anomaly_missing_address"


def test_mixed_cart_with_physical_item_and_no_address_is_anomaly():
    assert classify_shipping_address_gap(9, ["digital", "physical"], False) == "anomaly_missing_address"


def test_excluded_status_wins_over_missing_address_check():
    assert classify_shipping_address_gap(0, [], False) == "ok_excluded_status"


def test_no_line_items_and_no_address_is_ok_digital_only():
    assert classify_shipping_address_gap(11, [], False) == "ok_digital_only"


def test_all_real_post_checkout_statuses_flag_physical_with_no_address():
    for status_id in (1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14):
        assert classify_shipping_address_gap(status_id, ["physical"], False) == "anomaly_missing_address"
