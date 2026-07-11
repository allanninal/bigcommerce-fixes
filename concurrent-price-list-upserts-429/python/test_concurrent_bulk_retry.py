from serialize_price_list_upserts import decide_retry


def test_success_on_200():
    assert decide_retry(200, 1, {}) == {"action": "success"}


def test_success_on_201_created():
    assert decide_retry(201, 1, {}) == {"action": "success"}


def test_success_on_207_multi_status():
    assert decide_retry(207, 1, {}) == {"action": "success"}


def test_429_retries_with_reset_header_ms():
    result = decide_retry(429, 1, {"X-Rate-Limit-Time-Reset-Ms": "1500"}, max_attempts=6)
    assert result["action"] == "retry"
    assert result["wait_ms"] == 1500
    assert result["reason"] == "concurrent_bulk_lock"


def test_429_retries_with_retry_after_seconds():
    result = decide_retry(429, 1, {"Retry-After": "2"}, max_attempts=6)
    assert result["action"] == "retry"
    assert result["wait_ms"] == 2000
    assert result["reason"] == "concurrent_bulk_lock"


def test_429_falls_back_to_capped_exponential_backoff():
    result = decide_retry(429, 3, {}, max_attempts=6)
    assert result["action"] == "retry"
    # base 2000 * 2**(attempt-1) = 8000, plus up to 250ms of jitter
    assert 8000 <= result["wait_ms"] <= 8250


def test_429_backoff_is_capped_at_60_seconds():
    result = decide_retry(429, 10, {}, max_attempts=20)
    assert result["action"] == "retry"
    # capped at 60000, plus up to 250ms of jitter
    assert 60000 <= result["wait_ms"] <= 60250


def test_429_gives_up_after_max_attempts():
    result = decide_retry(429, 6, {}, max_attempts=6)
    assert result == {"action": "give_up", "reason": "max_attempts_exceeded"}


def test_non_429_client_error_gives_up_immediately():
    result = decide_retry(422, 1, {}, max_attempts=6)
    assert result == {"action": "give_up", "reason": "client_error_non_retryable"}


def test_401_unauthorized_gives_up_immediately():
    result = decide_retry(401, 1, {}, max_attempts=6)
    assert result == {"action": "give_up", "reason": "client_error_non_retryable"}


def test_server_error_retries_then_gives_up():
    retry = decide_retry(503, 1, {}, max_attempts=2)
    assert retry["action"] == "retry"
    assert retry["reason"] == "server_error"
    give_up = decide_retry(503, 2, {}, max_attempts=2)
    assert give_up == {"action": "give_up", "reason": "server_error_max_attempts"}


def test_malformed_reset_header_falls_back_to_backoff():
    result = decide_retry(429, 1, {"X-Rate-Limit-Time-Reset-Ms": "not-a-number"}, max_attempts=6)
    assert result["action"] == "retry"
    # base 2000 * 2**(1-1) = 2000, plus up to 250ms of jitter
    assert 2000 <= result["wait_ms"] <= 2250
