from diagnose_order_pricing import diagnose_order_line_pricing


def test_not_flagged_when_no_price_list_assigned():
    result = diagnose_order_line_pricing(None, None, None, "50.00", "50.00", 11, False)
    assert result["flagged"] is False
    assert result["reason"] == "no_price_list_assigned"
    assert result["recommended_action"] == "none"


def test_not_flagged_when_no_price_list_record_even_with_assignment():
    result = diagnose_order_line_pricing(5, 9, None, "50.00", "50.00", 11, False)
    assert result["flagged"] is False
    assert result["reason"] == "no_price_list_assigned"


def test_not_flagged_when_billed_matches_price_list():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "40.00", 11, False)
    assert result["flagged"] is False
    assert result["reason"] == "correctly_priced"
    assert result["recommended_action"] == "none"


def test_flagged_when_billed_at_catalog_price_ignoring_pricelist():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "50.00", 11, False)
    assert result["flagged"] is True
    assert result["reason"] == "billed_at_catalog_price_ignoring_pricelist"
    assert result["delta_ex_tax"] == "-10.00"
    assert result["recommended_action"] == "cancel_unpaid"


def test_recommends_cancel_unpaid_for_status_0_incomplete():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "50.00", 0, False)
    assert result["recommended_action"] == "cancel_unpaid"


def test_recommends_cancel_unpaid_for_status_7_awaiting_payment():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "50.00", 7, False)
    assert result["recommended_action"] == "cancel_unpaid"


def test_recommends_report_refund_delta_when_transaction_captured():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "50.00", 11, True)
    assert result["flagged"] is True
    assert result["recommended_action"] == "report_refund_delta"


def test_recommends_report_refund_delta_when_order_already_shipped():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "50.00", 2, False)
    assert result["flagged"] is True
    assert result["recommended_action"] == "report_refund_delta"


def test_recommends_report_refund_delta_for_status_9_awaiting_shipment_even_if_unpaid():
    # 9 (Awaiting Shipment) is not in the unpaid-cancellable set even though no
    # transaction was captured; it is outside {0, 7, 11}.
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "50.00", 9, False)
    assert result["flagged"] is True
    assert result["recommended_action"] == "report_refund_delta"


def test_flagged_billed_price_mismatch_unknown_source():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "45.00", 7, False)
    assert result["flagged"] is True
    assert result["reason"] == "billed_price_mismatch_unknown_source"
    assert result["recommended_action"] == "cancel_unpaid"


def test_delta_is_positive_when_billed_below_list_price():
    result = diagnose_order_line_pricing(5, 9, "40.00", "50.00", "35.00", 7, False)
    assert result["flagged"] is True
    assert result["delta_ex_tax"] == "5.00"
