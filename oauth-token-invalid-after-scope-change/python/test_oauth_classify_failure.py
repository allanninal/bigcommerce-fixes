from check_oauth_scope_drift import classify_auth_failure


def test_ok_when_status_is_not_401():
    assert classify_auth_failure(200, {"store_v2_orders"}, {"store_v2_orders"}, 0) == "OK"


def test_scope_drift_when_required_scope_is_missing():
    stored = {"store_v2_orders"}
    required = {"store_v2_orders", "store_v2_customers"}
    assert classify_auth_failure(401, stored, required, 0) == "SCOPE_DRIFT"


def test_scope_drift_wins_even_on_first_attempt():
    stored = {"store_v2_products"}
    required = {"store_v2_products", "store_v2_orders"}
    assert classify_auth_failure(401, stored, required, 0) == "SCOPE_DRIFT"


def test_transient_retry_when_scopes_match_and_first_attempt():
    scopes = {"store_v2_orders", "store_v2_products"}
    assert classify_auth_failure(401, scopes, scopes, 0) == "TRANSIENT_RETRY"


def test_revoked_or_expired_when_scopes_match_after_retry():
    scopes = {"store_v2_orders", "store_v2_products"}
    assert classify_auth_failure(401, scopes, scopes, 1) == "TOKEN_REVOKED_OR_EXPIRED"


def test_revoked_or_expired_stays_final_on_further_retries():
    scopes = {"store_v2_orders"}
    assert classify_auth_failure(401, scopes, scopes, 3) == "TOKEN_REVOKED_OR_EXPIRED"


def test_ok_wins_even_if_scopes_are_missing():
    stored = set()
    required = {"store_v2_orders"}
    assert classify_auth_failure(200, stored, required, 0) == "OK"


def test_scope_drift_when_stored_scopes_are_completely_empty():
    stored = set()
    required = {"store_v2_orders"}
    assert classify_auth_failure(401, stored, required, 0) == "SCOPE_DRIFT"
