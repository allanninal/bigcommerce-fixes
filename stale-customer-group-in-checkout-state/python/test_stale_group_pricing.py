from decimal import Decimal

from flag_stale_group_orders import is_order_mispriced


def test_not_mispriced_when_groups_match():
    assert is_order_mispriced(10, 10, Decimal("45.00"), Decimal("50.00")) is False


def test_mispriced_when_groups_diverge_and_price_differs():
    assert is_order_mispriced(10, 20, Decimal("40.00"), Decimal("50.00")) is True


def test_not_mispriced_when_groups_diverge_but_price_is_identical():
    assert is_order_mispriced(10, 20, Decimal("50.00"), Decimal("50.00")) is False


def test_not_mispriced_within_rounding_tolerance():
    assert is_order_mispriced(10, 20, Decimal("50.00"), Decimal("50.005")) is False


def test_mispriced_just_beyond_tolerance():
    assert is_order_mispriced(10, 20, Decimal("50.00"), Decimal("50.02")) is True


def test_custom_tolerance_is_respected():
    assert is_order_mispriced(10, 20, Decimal("50.00"), Decimal("50.50"), tolerance=Decimal("1.00")) is False


def test_negative_delta_direction_does_not_matter():
    # current_group_unit_price higher than charged should behave the same as lower.
    assert is_order_mispriced(10, 20, Decimal("60.00"), Decimal("50.00")) is True


def test_exactly_at_tolerance_boundary_is_not_flagged():
    assert is_order_mispriced(10, 20, Decimal("50.00"), Decimal("50.01")) is False
