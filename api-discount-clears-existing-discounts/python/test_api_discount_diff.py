from detect_cleared_discounts import diff_discount_state


def snapshot(discount_ids=None, coupon_codes=None, total="100.00"):
    return {
        "discountIds": discount_ids or [],
        "couponCodes": coupon_codes or [],
        "totalDiscountedAmount": total,
    }


def test_not_affected_when_nothing_lost():
    before = snapshot(["1"], ["SAVE10"], "90.00")
    after = snapshot(["1", "2"], ["SAVE10"], "80.00")
    result = diff_discount_state(before, after)
    assert result["isAffected"] is False
    assert result["lostDiscountIds"] == []
    assert result["lostCouponCodes"] == []


def test_affected_when_coupon_is_lost():
    before = snapshot(["1"], ["SAVE10"], "90.00")
    after = snapshot(["2"], [], "95.00")
    result = diff_discount_state(before, after)
    assert result["isAffected"] is True
    assert result["lostDiscountIds"] == ["1"]
    assert result["lostCouponCodes"] == ["SAVE10"]


def test_affected_when_discount_id_is_lost_but_coupon_survives():
    before = snapshot(["1", "2"], ["SAVE10"], "90.00")
    after = snapshot(["2"], ["SAVE10"], "92.00")
    result = diff_discount_state(before, after)
    assert result["isAffected"] is True
    assert result["lostDiscountIds"] == ["1"]
    assert result["lostCouponCodes"] == []


def test_total_delta_is_decimal_safe():
    before = snapshot(["1"], ["SAVE10"], "90.10")
    after = snapshot([], [], "100.00")
    result = diff_discount_state(before, after)
    assert result["totalDelta"] == "-9.90"


def test_not_affected_when_before_snapshot_is_empty():
    before = snapshot([], [], "100.00")
    after = snapshot(["1"], ["SAVE10"], "90.00")
    result = diff_discount_state(before, after)
    assert result["isAffected"] is False


def test_affected_when_all_discounts_and_coupons_wiped():
    before = snapshot(["1", "2"], ["SAVE10", "WELCOME"], "70.00")
    after = snapshot([], [], "100.00")
    result = diff_discount_state(before, after)
    assert result["isAffected"] is True
    assert result["lostDiscountIds"] == ["1", "2"]
    assert result["lostCouponCodes"] == ["SAVE10", "WELCOME"]
    assert result["totalDelta"] == "-30.00"
