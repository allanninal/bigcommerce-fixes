from resolve_duplicate_customer import resolve_duplicate_customer_action


def already_in_use_response(field="email"):
    return {
        "status": 422,
        "title": "The email address you entered is already in use by a customer.",
        "errors": {field: "already in use"},
    }


def test_flags_already_in_use_error_as_duplicate():
    decision = resolve_duplicate_customer_action(already_in_use_response(), ["shopper@example.com"])
    assert decision["is_duplicate_email_error"] is True
    assert decision["next_action"] == "lookup_by_email"


def test_returns_all_submitted_emails_as_candidates():
    decision = resolve_duplicate_customer_action(
        already_in_use_response(), ["a@example.com", "b@example.com"]
    )
    assert decision["candidate_emails"] == ["a@example.com", "b@example.com"]


def test_ignores_unrelated_422_errors():
    response = {"status": 422, "title": "First name is required.", "errors": {"first_name": "required"}}
    decision = resolve_duplicate_customer_action(response, ["shopper@example.com"])
    assert decision["is_duplicate_email_error"] is False
    assert decision["next_action"] == "raise"
    assert decision["candidate_emails"] == []


def test_ignores_non_422_status_even_with_matching_message():
    response = {"status": 500, "title": "already in use", "errors": {}}
    decision = resolve_duplicate_customer_action(response, ["shopper@example.com"])
    assert decision["is_duplicate_email_error"] is False


def test_matches_message_inside_errors_list_form():
    response = {
        "status": 422,
        "title": "Unprocessable Entity",
        "errors": [{"message": "Email address already in use by a customer."}],
    }
    decision = resolve_duplicate_customer_action(response, ["shopper@example.com"])
    assert decision["is_duplicate_email_error"] is True


def test_no_candidates_when_submitted_emails_is_empty():
    decision = resolve_duplicate_customer_action(already_in_use_response(), [])
    assert decision["is_duplicate_email_error"] is True
    assert decision["candidate_emails"] == []
