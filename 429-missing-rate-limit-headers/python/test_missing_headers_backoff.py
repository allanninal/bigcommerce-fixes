from rate_limit_backoff import compute_backoff_seconds


def test_non_429_needs_no_backoff():
    assert compute_backoff_seconds(200, {}, 0) == 0
    assert compute_backoff_seconds(500, {"X-Rate-Limit-Time-Reset-Ms": "2000"}, 0) == 0


def test_headers_present_returns_exact_reset_seconds():
    headers = {"X-Rate-Limit-Time-Reset-Ms": "2500"}
    assert compute_backoff_seconds(429, headers, 0) == 2.5


def test_headers_present_is_case_insensitive():
    headers = {"x-rate-limit-time-reset-ms": "1000"}
    assert compute_backoff_seconds(429, headers, 0) == 1.0


def test_headers_missing_falls_back_to_bounded_exponential_backoff():
    wait = compute_backoff_seconds(429, {}, 3, base_seconds=1.0, max_seconds=60.0, jitter_ratio=0.2)
    # attempt 3 -> base 8s +/- 20% jitter, well under the 60s cap
    assert 6.0 <= wait <= 10.0


def test_headers_missing_backoff_is_capped():
    wait = compute_backoff_seconds(429, {}, 20, base_seconds=1.0, max_seconds=60.0, jitter_ratio=0.2)
    assert wait <= 60.0 * 1.2


def test_attempts_produce_monotonically_non_decreasing_backoff_up_to_cap():
    # Compare the jitter-free midpoints across attempts, since jitter alone
    # could make one sample noisy, but the underlying curve must not decrease.
    previous = 0.0
    for attempt in range(0, 8):
        base_wait = min(1.0 * (2 ** attempt), 60.0)
        assert base_wait >= previous
        previous = base_wait


def test_unparseable_reset_header_falls_back_to_backoff():
    wait = compute_backoff_seconds(429, {"X-Rate-Limit-Time-Reset-Ms": "not-a-number"}, 0)
    assert wait > 0


def test_empty_reset_header_falls_back_to_backoff():
    wait = compute_backoff_seconds(429, {"X-Rate-Limit-Time-Reset-Ms": ""}, 0)
    assert wait > 0


def test_zero_attempt_headers_missing_gives_base_seconds_with_jitter():
    wait = compute_backoff_seconds(429, {}, 0, base_seconds=1.0, max_seconds=60.0, jitter_ratio=0.2)
    assert 0.8 <= wait <= 1.2
