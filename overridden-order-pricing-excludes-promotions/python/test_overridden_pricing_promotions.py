from flag_overridden_pricing_promotions import flag_missing_promotion


def base_order(**overrides):
    order = {
        "id": 501,
        "discount_amount": "0.00",
        "coupon_discount": "0.00",
        "subtotal_ex_tax": "80.00",
        "base_total_ex_tax": "100.00",
        "customer_group_id": 0,
        "date_created": "2026-07-01",
    }
    order.update(overrides)
    return order


def override_line_item(price_ex_tax="80.00", base_price="100.00", applied_discounts=None):
    return {
        "product_id": 42,
        "price_ex_tax": price_ex_tax,
        "base_price": base_price,
        "applied_discounts": applied_discounts or [],
    }


def automatic_promo(promo_id=9001):
    return {"id": promo_id, "redemption_type": "AUTOMATIC", "rules": [], "current_days_and_times": {}}


def test_flags_override_with_no_discount_and_active_automatic_promo():
    flag = flag_missing_promotion(
        base_order(), [override_line_item()], [], [automatic_promo()]
    )
    assert flag == {
        "order_id": 501,
        "reason": "price_override_excluded_from_active_automatic_promotion",
        "has_price_override": True,
        "expected_promo_ids": [9001],
    }


def test_no_flag_when_price_matches_base_price():
    line_items = [override_line_item(price_ex_tax="100.00", base_price="100.00")]
    assert flag_missing_promotion(base_order(), line_items, [], [automatic_promo()]) is None


def test_no_flag_when_discount_amount_is_recorded():
    order = base_order(discount_amount="10.00")
    assert flag_missing_promotion(order, [override_line_item()], [], [automatic_promo()]) is None


def test_no_flag_when_order_coupons_present():
    coupons = [{"code": "SAVE10", "amount": "10.00", "type": "percentage_discount"}]
    assert flag_missing_promotion(base_order(), [override_line_item()], coupons, [automatic_promo()]) is None


def test_no_flag_when_line_item_has_applied_discounts():
    line_items = [override_line_item(applied_discounts=[{"amount": "5.00"}])]
    assert flag_missing_promotion(base_order(), line_items, [], [automatic_promo()]) is None


def test_no_flag_when_no_active_automatic_promotion_exists():
    coupon_only_promo = {"id": 1, "redemption_type": "COUPON", "rules": [], "current_days_and_times": {}}
    assert flag_missing_promotion(base_order(), [override_line_item()], [], [coupon_only_promo]) is None


def test_no_flag_when_no_price_override_present():
    line_items = [{"product_id": 42, "price_ex_tax": None, "base_price": "100.00", "applied_discounts": []}]
    assert flag_missing_promotion(base_order(), line_items, [], [automatic_promo()]) is None


def test_no_flag_when_amount_present_but_equal_types_differ_numerically_same():
    # Guards against false positives when price_ex_tax equals base_price
    # even when one is a string and the other a numeric-looking string.
    line_items = [override_line_item(price_ex_tax="100.00", base_price="100.00")]
    assert flag_missing_promotion(base_order(discount_amount="0"), line_items, [], [automatic_promo()]) is None


def test_flags_multiple_eligible_automatic_promotions():
    promos = [automatic_promo(1), automatic_promo(2), {"id": 3, "redemption_type": "COUPON", "rules": []}]
    flag = flag_missing_promotion(base_order(), [override_line_item()], [], promos)
    assert flag["expected_promo_ids"] == [1, 2]
