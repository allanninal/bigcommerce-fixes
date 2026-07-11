from rate_limit_guard import should_throttle


def test_no_throttle_when_requests_left_above_threshold():
    assert should_throttle(50, 30000, min_requests_remaining=10, status_code=200) == (False, 0)


def test_throttle_when_requests_left_below_threshold():
    throttle, wait_ms = should_throttle(5, 30000, min_requests_remaining=10, status_code=200)
    assert throttle is True
    assert wait_ms == 30000


def test_throttle_when_requests_left_equals_threshold():
    throttle, _ = should_throttle(10, 15000, min_requests_remaining=10, status_code=200)
    assert throttle is True


def test_throttle_on_429_even_when_requests_left_still_high():
    throttle, wait_ms = should_throttle(120, 8000, min_requests_remaining=10, status_code=429)
    assert throttle is True
    assert wait_ms == 8000


def test_throttle_with_zero_time_reset_ms_returns_zero_wait():
    throttle, wait_ms = should_throttle(2, 0, min_requests_remaining=10, status_code=200)
    assert throttle is True
    assert wait_ms == 0


def test_missing_requests_left_defaults_to_throttle():
    throttle, _ = should_throttle(None, 30000, min_requests_remaining=10, status_code=200)
    assert throttle is True


def test_negative_time_reset_ms_defaults_to_zero_wait():
    throttle, wait_ms = should_throttle(5, -100, min_requests_remaining=10, status_code=200)
    assert throttle is True
    assert wait_ms == 0


def test_negative_requests_left_defaults_to_throttle():
    throttle, _ = should_throttle(-1, 30000, min_requests_remaining=10, status_code=200)
    assert throttle is True
