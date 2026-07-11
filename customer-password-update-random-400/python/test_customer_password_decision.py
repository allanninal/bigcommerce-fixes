from recheck_password_updates import decide_password_update_outcome


def test_confirmed_success_when_date_modified_advances_despite_400():
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:05Z", 400, {"errors": ["stale retry"]}, 118
    )
    assert result == "confirmed_success"


def test_needs_retry_on_rate_limit_status():
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 429, {}, 118, retry_count=0
    )
    assert result == "needs_retry"


def test_needs_retry_on_server_error():
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 500, {}, 118, retry_count=1
    )
    assert result == "needs_retry"


def test_needs_retry_on_concurrency_error_body():
    body = {"title": "Too many concurrent requests"}
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 400, body, 118, retry_count=0
    )
    assert result == "needs_retry"


def test_needs_human_review_when_retries_exhausted():
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 429, {}, 118, retry_count=3
    )
    assert result == "needs_human_review"


def test_needs_human_review_on_persistent_complexity_error():
    body = {"title": "The password does not meet complexity requirements."}
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 400, body, 118, retry_count=0
    )
    assert result == "needs_human_review"


def test_needs_human_review_when_no_date_modified_and_no_transient_signal():
    result = decide_password_update_outcome(
        "2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z", 400, {}, 118, retry_count=0
    )
    assert result == "needs_human_review"
