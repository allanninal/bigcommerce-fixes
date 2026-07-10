from decimal import Decimal

from sync_gateway_refunds import decide_refund_status


def test_already_reconciled_is_none():
    result = decide_refund_status(Decimal("100.00"), 10, Decimal("0.00"), Decimal("0.00"))
    assert result["action"] == "none"


def test_full_refund_not_yet_recorded_sets_status_4():
    result = decide_refund_status(Decimal("100.00"), 10, Decimal("100.00"), Decimal("0.00"))
    assert result["action"] == "set_status"
    assert result["target_status_id"] == 4


def test_partial_refund_not_yet_recorded_sets_status_14():
    result = decide_refund_status(Decimal("100.00"), 11, Decimal("40.00"), Decimal("0.00"))
    assert result["action"] == "set_status"
    assert result["target_status_id"] == 14


def test_already_matches_bc_recorded_amount_is_none():
    result = decide_refund_status(Decimal("100.00"), 10, Decimal("40.00"), Decimal("40.00"))
    assert result["action"] == "none"


def test_partial_topped_up_to_full_moves_to_status_4():
    # BigCommerce recorded a 40 partial refund already, gateway shows the full 100 refunded
    result = decide_refund_status(Decimal("100.00"), 14, Decimal("100.00"), Decimal("40.00"))
    assert result["action"] == "set_status"
    assert result["target_status_id"] == 4


def test_order_already_at_target_status_is_none():
    result = decide_refund_status(Decimal("100.00"), 4, Decimal("100.00"), Decimal("0.00"))
    assert result["action"] == "none"


def test_order_already_at_partial_target_status_is_none():
    result = decide_refund_status(Decimal("100.00"), 14, Decimal("40.00"), Decimal("0.00"))
    assert result["action"] == "none"


def test_negative_gateway_amount_flags_manual_review():
    result = decide_refund_status(Decimal("100.00"), 10, Decimal("-5.00"), Decimal("0.00"))
    assert result["action"] == "flag_manual_review"


def test_gateway_amount_exceeding_total_flags_manual_review():
    result = decide_refund_status(Decimal("100.00"), 10, Decimal("150.00"), Decimal("0.00"))
    assert result["action"] == "flag_manual_review"


def test_rounding_tolerance_treats_near_total_as_full_refund():
    # within a cent of the total should count as a full refund, not a partial
    result = decide_refund_status(Decimal("100.00"), 10, Decimal("99.995"), Decimal("0.00"))
    assert result["action"] == "set_status"
    assert result["target_status_id"] == 4


def test_gateway_less_than_or_equal_bc_recorded_after_partial_is_none():
    result = decide_refund_status(Decimal("100.00"), 14, Decimal("40.00"), Decimal("60.00"))
    assert result["action"] == "none"
