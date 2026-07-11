from reconcile_truncated_skus import is_truncated


def test_no_limit_requested_and_records_equal_default_and_total_exceeds_it():
    assert is_truncated(50, None, 80) is True


def test_no_limit_requested_and_total_equals_records_fetched():
    assert is_truncated(50, None, 50) is False


def test_no_limit_requested_and_records_fetched_under_default():
    assert is_truncated(30, None, 30) is False


def test_explicit_limit_requested_and_records_fall_short_of_true_total():
    assert is_truncated(200, 250, 260) is True


def test_explicit_limit_requested_and_records_match_the_smaller_of_limit_and_total():
    assert is_truncated(100, 250, 100) is False


def test_explicit_limit_requested_and_records_match_the_limit_itself():
    assert is_truncated(250, 250, 250) is False
