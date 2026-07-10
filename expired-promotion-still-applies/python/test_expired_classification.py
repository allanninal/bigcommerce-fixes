from disable_expired_promotions import classify_promotion

NOW = "2026-07-10T00:00:00Z"


def promo(**over):
    base = {
        "status": "ENABLED",
        "end_date": "2026-08-01T00:00:00Z",
        "start_date": "2026-01-01T00:00:00Z",
        "current_uses": 0,
        "max_uses": None,
        "redemption_type": "COUPON",
    }
    base.update(over)
    return base


def test_not_expired_when_disabled_already():
    result = classify_promotion(promo(status="DISABLED", end_date="2026-01-01T00:00:00Z"), NOW)
    assert result == {"expired": False, "reason": None, "action": "NONE"}


def test_not_expired_when_end_date_in_future():
    result = classify_promotion(promo(), NOW)
    assert result == {"expired": False, "reason": None, "action": "NONE"}


def test_expired_past_end_date():
    result = classify_promotion(promo(end_date="2026-06-01T00:00:00Z"), NOW)
    assert result == {"expired": True, "reason": "past_end_date", "action": "DISABLE"}


def test_expired_when_end_date_equals_now():
    result = classify_promotion(promo(end_date=NOW), NOW)
    assert result["expired"] is True
    assert result["reason"] == "past_end_date"


def test_never_expires_with_null_end_date_unless_max_uses_hit():
    result = classify_promotion(promo(end_date=None), NOW)
    assert result == {"expired": False, "reason": None, "action": "NONE"}


def test_expired_when_max_uses_reached():
    result = classify_promotion(promo(end_date=None, current_uses=50, max_uses=50), NOW)
    assert result == {"expired": True, "reason": "max_uses_reached", "action": "DISABLE"}


def test_not_expired_when_under_max_uses():
    result = classify_promotion(promo(end_date=None, current_uses=49, max_uses=50), NOW)
    assert result == {"expired": False, "reason": None, "action": "NONE"}


def test_status_check_wins_even_if_end_date_and_max_uses_both_expired():
    result = classify_promotion(
        promo(status="DISABLED", end_date="2026-01-01T00:00:00Z", current_uses=50, max_uses=50), NOW
    )
    assert result == {"expired": False, "reason": None, "action": "NONE"}


def test_past_end_date_takes_priority_over_max_uses_reason():
    result = classify_promotion(
        promo(end_date="2026-01-01T00:00:00Z", current_uses=50, max_uses=50), NOW
    )
    assert result["reason"] == "past_end_date"
