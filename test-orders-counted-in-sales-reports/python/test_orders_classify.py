from flag_test_orders import classify_test_order


def order(**over):
    base = {
        "status_id": 10,
        "customer_id": 42,
        "total_inc_tax": "89.00",
        "billing_address": {"email": "shopper@realcustomer.com"},
    }
    base.update(over)
    return base


def txn(**over):
    base = {"test": False, "gateway": "Authorize.net"}
    base.update(over)
    return base


def test_not_test_order_for_ordinary_paid_order():
    result = classify_test_order(order(), [txn()])
    assert result["isTest"] is False
    assert result["reasons"] == []


def test_flagged_when_transaction_test_flag_is_true():
    result = classify_test_order(order(), [txn(test=True)])
    assert result["isTest"] is True
    assert "test_gateway_transaction" in result["reasons"]


def test_flagged_when_gateway_name_is_test_payment_gateway():
    result = classify_test_order(order(), [txn(gateway="Test Payment Gateway")])
    assert result["isTest"] is True
    assert "test_gateway_name" in result["reasons"]


def test_flagged_when_billing_email_matches_test_pattern():
    o = order(billing_address={"email": "qa-checkout@company.com"})
    result = classify_test_order(o, [txn()])
    assert result["isTest"] is True
    assert "test_email_pattern" in result["reasons"]


def test_flagged_when_guest_checkout_with_nominal_total():
    o = order(customer_id=0, total_inc_tax="0.50")
    result = classify_test_order(o, [txn()])
    assert result["isTest"] is True
    assert "nominal_staff_test_amount" in result["reasons"]


def test_guest_checkout_with_real_total_is_not_flagged_alone():
    o = order(customer_id=0, total_inc_tax="89.00")
    result = classify_test_order(o, [txn()])
    assert result["isTest"] is False


def test_non_revenue_status_alone_does_not_mark_as_test():
    o = order(status_id=5)  # Cancelled
    result = classify_test_order(o, [txn()])
    assert result["isTest"] is False
    assert "non_revenue_status" in result["reasons"]


def test_non_revenue_status_combined_with_test_signal_still_flags():
    o = order(status_id=0)  # Incomplete
    result = classify_test_order(o, [txn(test=True)])
    assert result["isTest"] is True
    assert "non_revenue_status" in result["reasons"]
    assert "test_gateway_transaction" in result["reasons"]


def test_email_pattern_is_case_insensitive():
    o = order(billing_address={"email": "QA-Lead@Company.com"})
    result = classify_test_order(o, [txn()])
    assert result["isTest"] is True
    assert "test_email_pattern" in result["reasons"]


def test_missing_billing_address_does_not_raise():
    o = order(billing_address=None)
    result = classify_test_order(o, [txn()])
    assert result["isTest"] is False


def test_multiple_reasons_all_collected():
    o = order(customer_id=0, total_inc_tax="0.01", billing_address={"email": "test@test.com"})
    result = classify_test_order(o, [txn(test=True, gateway="Test Payment Gateway")])
    assert result["isTest"] is True
    assert set(result["reasons"]) == {
        "test_gateway_transaction",
        "test_gateway_name",
        "test_email_pattern",
        "nominal_staff_test_amount",
    }


def test_custom_email_patterns_are_respected():
    o = order(billing_address={"email": "staging@internal-corp.com"})
    result = classify_test_order(o, [txn()], test_email_patterns=[__import__("re").compile(r"@internal-corp\.com$")])
    assert result["isTest"] is True
    assert "test_email_pattern" in result["reasons"]
