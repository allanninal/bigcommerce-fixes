from decimal import Decimal

from detect_coupon_overwrite import detect_coupon_overwrite


def snapshot(coupon_discount="10.00", total_inc_tax="90.00", date_modified="2026-07-01T10:00:00Z"):
    return {
        "order_id": 501,
        "coupon_discount": Decimal(coupon_discount),
        "total_inc_tax": Decimal(total_inc_tax),
        "total_ex_tax": Decimal(total_inc_tax),
        "date_modified": date_modified,
    }


def live(coupon_discount="10.00", total_inc_tax="90.00", date_modified="2026-07-01T10:00:00Z"):
    return {
        "order_id": 501,
        "coupon_discount": Decimal(coupon_discount),
        "total_inc_tax": Decimal(total_inc_tax),
        "total_ex_tax": Decimal(total_inc_tax),
        "date_modified": date_modified,
    }


def coupon(discount="10.00", code="SAVE10"):
    return {"code": code, "discount": Decimal(discount), "type": 1}


def test_not_corrupted_when_nothing_changed():
    result = detect_coupon_overwrite(snapshot(), live(), [coupon()])
    assert result["is_corrupted"] is False


def test_not_corrupted_when_no_active_coupon():
    result = detect_coupon_overwrite(snapshot(coupon_discount="0.00"), live(coupon_discount="0.00"), [])
    assert result["is_corrupted"] is False


def test_corrupted_when_discount_wiped_but_total_unchanged():
    live_order = live(coupon_discount="0.00", total_inc_tax="90.00", date_modified="2026-07-05T10:00:00Z")
    result = detect_coupon_overwrite(snapshot(), live_order, [coupon()])
    assert result["is_corrupted"] is True
    # The full 10.00 discount dropped off coupon_discount (10.00 -> 0.00), which
    # exactly matches expected_discount, so delta_missing (the shortfall between
    # what disappeared from coupon_discount and what the coupon says should have
    # applied) is 0. is_corrupted is driven by the total not falling to match.
    assert result["delta_missing"] == Decimal("0.00")


def test_delta_missing_reflects_a_partial_drop_in_coupon_discount():
    # coupon_discount only fell from 10.00 to 6.00 (a drop of 4.00, not the
    # full 10.00), so delta_missing = expected_discount - actual_drop = 6.00.
    live_order = live(coupon_discount="6.00", total_inc_tax="90.00", date_modified="2026-07-05T10:00:00Z")
    result = detect_coupon_overwrite(snapshot(), live_order, [coupon()])
    assert result["is_corrupted"] is True
    assert result["delta_missing"] == Decimal("6.00")


def test_not_corrupted_when_total_dropped_by_the_expected_discount():
    live_order = live(coupon_discount="0.00", total_inc_tax="80.00", date_modified="2026-07-05T10:00:00Z")
    result = detect_coupon_overwrite(snapshot(), live_order, [coupon()])
    assert result["is_corrupted"] is False


def test_not_corrupted_when_discount_increased():
    live_order = live(coupon_discount="15.00", total_inc_tax="85.00", date_modified="2026-07-05T10:00:00Z")
    result = detect_coupon_overwrite(snapshot(), live_order, [coupon(discount="15.00")])
    assert result["is_corrupted"] is False


def test_corrupted_when_total_drop_only_partially_covers_the_discount():
    live_order = live(coupon_discount="0.00", total_inc_tax="88.00", date_modified="2026-07-05T10:00:00Z")
    result = detect_coupon_overwrite(snapshot(), live_order, [coupon()])
    assert result["is_corrupted"] is True


def test_not_corrupted_when_date_modified_is_unchanged_even_if_values_differ():
    live_order = live(coupon_discount="0.00", total_inc_tax="90.00", date_modified="2026-07-01T10:00:00Z")
    result = detect_coupon_overwrite(snapshot(), live_order, [coupon()])
    assert result["is_corrupted"] is False
