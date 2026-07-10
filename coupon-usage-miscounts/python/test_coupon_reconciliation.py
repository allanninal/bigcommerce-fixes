from reconcile_coupon_usage import reconcile_coupon_usage


def coupon(id=1, code="SAVE10", num_uses=5, max_uses=10, max_uses_per_customer=None):
    return {"id": id, "code": code, "num_uses": num_uses,
            "max_uses": max_uses, "max_uses_per_customer": max_uses_per_customer}


def order(order_id, status_id, code="SAVE10"):
    return {"order_id": order_id, "status_id": status_id, "coupon_code": code}


def test_no_drift_when_reported_matches_true():
    orders = [order(1, 10), order(2, 10), order(3, 2)]
    result = reconcile_coupon_usage(coupon(num_uses=3), orders)
    assert result["true_uses"] == 3
    assert result["delta"] == 0
    assert result["drifted"] is False
    assert result["offending_order_ids"] == []


def test_drift_when_cancelled_orders_still_counted():
    orders = [order(1, 10), order(2, 5), order(3, 6)]
    result = reconcile_coupon_usage(coupon(num_uses=3), orders)
    assert result["true_uses"] == 1
    assert result["delta"] == 2
    assert result["drifted"] is True
    assert result["offending_order_ids"] == [2, 3]


def test_refunded_and_partially_refunded_are_offending():
    orders = [order(1, 10), order(2, 4), order(3, 14)]
    result = reconcile_coupon_usage(coupon(num_uses=3), orders)
    assert result["true_uses"] == 1
    assert result["offending_order_ids"] == [2, 3]


def test_no_orders_at_all_is_full_delta():
    result = reconcile_coupon_usage(coupon(num_uses=4), [])
    assert result["true_uses"] == 0
    assert result["delta"] == 4
    assert result["drifted"] is True
    assert result["offending_order_ids"] == []


def test_tolerance_absorbs_small_delta():
    orders = [order(1, 10)]
    result = reconcile_coupon_usage(coupon(num_uses=2), orders, tolerance=1)
    assert result["delta"] == 1
    assert result["drifted"] is False


def test_negative_delta_is_not_drifted():
    orders = [order(1, 10), order(2, 10), order(3, 10)]
    result = reconcile_coupon_usage(coupon(num_uses=1), orders)
    assert result["delta"] == -2
    assert result["drifted"] is False


def test_offending_order_ids_sorted():
    orders = [order(9, 5), order(2, 6), order(7, 0)]
    result = reconcile_coupon_usage(coupon(num_uses=3), orders)
    assert result["offending_order_ids"] == [2, 7, 9]


def test_awaiting_payment_counts_as_valid():
    orders = [order(1, 7)]
    result = reconcile_coupon_usage(coupon(num_uses=1), orders)
    assert result["true_uses"] == 1
    assert result["drifted"] is False
