from clean_stale_carts import classify_stale_cart

NOW = "2026-07-10T00:00:00+00:00"


def cart(updated_time="2026-07-09T00:00:00+00:00", physical=1, digital=0, custom=0, gift_cert=0):
    return {
        "id": "cart-1",
        "customerId": 42,
        "email": "buyer@example.com",
        "createdTime": updated_time,
        "updatedTime": updated_time,
        "lineItemCounts": {"physical": physical, "digital": digital, "custom": custom, "giftCert": gift_cert},
    }


def test_active_when_recent_and_has_items():
    c = cart(updated_time="2026-07-09T00:00:00+00:00")
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result == {"isStale": False, "reason": "active"}


def test_empty_cart_past_threshold_is_safe_to_delete():
    c = cart(updated_time="2026-05-01T00:00:00+00:00", physical=0)
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result == {"isStale": True, "reason": "empty_cart"}


def test_empty_but_recent_is_active():
    c = cart(updated_time="2026-07-05T00:00:00+00:00", physical=0)
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result["isStale"] is False


def test_converted_duplicate_regardless_of_age():
    c = cart(updated_time="2026-07-09T00:00:00+00:00", physical=2)
    result = classify_stale_cart(c, True, NOW, stale_days=30)
    assert result == {"isStale": True, "reason": "converted_duplicate"}


def test_converted_duplicate_beats_empty_cart_reason():
    c = cart(updated_time="2026-05-01T00:00:00+00:00", physical=0)
    result = classify_stale_cart(c, True, NOW, stale_days=30)
    assert result == {"isStale": True, "reason": "empty_cart"}


def test_abandoned_stale_has_items_old_and_no_order():
    c = cart(updated_time="2026-05-01T00:00:00+00:00", physical=3)
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result == {"isStale": True, "reason": "abandoned_stale"}


def test_abandoned_stale_never_returned_for_recent_cart():
    c = cart(updated_time="2026-07-01T00:00:00+00:00", physical=3)
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result["reason"] != "abandoned_stale"
    assert result["isStale"] is False


def test_digital_and_gift_cert_items_count_toward_total():
    c = cart(updated_time="2026-05-01T00:00:00+00:00", physical=0, digital=1)
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result == {"isStale": True, "reason": "abandoned_stale"}


def test_custom_stale_days_threshold_is_respected():
    c = cart(updated_time="2026-07-05T00:00:00+00:00", physical=0)
    result = classify_stale_cart(c, False, NOW, stale_days=3)
    assert result == {"isStale": True, "reason": "empty_cart"}


def test_exact_threshold_boundary_is_not_stale():
    c = cart(updated_time="2026-06-10T00:00:00+00:00", physical=0)
    result = classify_stale_cart(c, False, NOW, stale_days=30)
    assert result["isStale"] is False
