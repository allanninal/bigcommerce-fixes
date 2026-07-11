from reconcile_brand_product_race import decide_action


def test_noop_success_when_both_confirmed():
    assert decide_action(True, True, 50, 0) == "noop_success"


def test_retry_create_when_brand_confirmed_and_product_missing():
    assert decide_action(True, False, 50, 0) == "retry_create"


def test_wait_and_retry_when_rate_limit_exhausted():
    assert decide_action(True, False, 0, 1) == "wait_and_retry"


def test_flag_manual_review_when_brand_not_confirmed():
    assert decide_action(False, False, 50, 0) == "flag_manual_review"


def test_flag_manual_review_even_if_product_exists_but_brand_not_confirmed():
    assert decide_action(False, True, 50, 0) == "flag_manual_review"


def test_give_up_after_max_attempts_without_product():
    assert decide_action(True, False, 50, 5, max_attempts=5) == "give_up"


def test_noop_success_takes_priority_over_give_up():
    assert decide_action(True, True, 0, 5, max_attempts=5) == "noop_success"


def test_retry_create_at_zero_attempt_with_full_rate_limit():
    assert decide_action(True, False, 150, 0, max_attempts=5) == "retry_create"


def test_wait_and_retry_takes_priority_over_retry_when_rate_limit_zero():
    assert decide_action(True, False, 0, 0, max_attempts=5) == "wait_and_retry"
