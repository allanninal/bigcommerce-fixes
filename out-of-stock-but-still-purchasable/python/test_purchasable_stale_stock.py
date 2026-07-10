from find_stale_in_stock import is_stale_in_stock


def test_flags_when_tracked_product_level_zero_and_available():
    assert is_stale_in_stock("product", 0, "available", False) is True


def test_flags_when_tracked_variant_level_negative_and_available():
    assert is_stale_in_stock("variant", -1, "available", False) is True


def test_no_flag_when_tracking_is_none():
    assert is_stale_in_stock("none", 0, "available", False) is False


def test_no_flag_when_still_in_stock():
    assert is_stale_in_stock("product", 5, "available", False) is False


def test_no_flag_when_already_disabled():
    assert is_stale_in_stock("product", 0, "disabled", False) is False


def test_no_flag_when_purchasing_already_disabled():
    assert is_stale_in_stock("variant", 0, "available", True) is False


def test_no_flag_when_preorder_availability():
    assert is_stale_in_stock("product", 0, "preorder", False) is False
