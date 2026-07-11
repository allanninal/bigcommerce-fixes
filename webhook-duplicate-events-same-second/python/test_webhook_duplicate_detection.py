from dedupe_same_second_webhooks import is_duplicate_webhook_event


def test_first_event_is_not_a_duplicate():
    seen = {}
    assert is_duplicate_webhook_event(seen, 501, 11, 1000.0) is False
    assert seen[(501, 11)] == 1000.0


def test_second_event_within_window_is_a_duplicate():
    seen = {(501, 11): 1000.0}
    assert is_duplicate_webhook_event(seen, 501, 11, 1000.8) is True


def test_event_exactly_at_window_edge_is_a_duplicate():
    seen = {(501, 11): 1000.0}
    assert is_duplicate_webhook_event(seen, 501, 11, 1002.0, window_seconds=2.0) is True


def test_event_just_outside_window_is_not_a_duplicate():
    seen = {(501, 11): 1000.0}
    assert is_duplicate_webhook_event(seen, 501, 11, 1002.1, window_seconds=2.0) is False


def test_out_of_order_timestamp_within_window_is_still_a_duplicate():
    seen = {(501, 11): 1005.0}
    assert is_duplicate_webhook_event(seen, 501, 11, 1004.0, window_seconds=2.0) is True


def test_different_status_id_is_a_distinct_event_not_a_duplicate():
    seen = {(501, 11): 1000.0}
    assert is_duplicate_webhook_event(seen, 501, 12, 1000.2) is False


def test_different_resource_id_is_a_distinct_event_not_a_duplicate():
    seen = {(501, 11): 1000.0}
    assert is_duplicate_webhook_event(seen, 502, 11, 1000.2) is False
