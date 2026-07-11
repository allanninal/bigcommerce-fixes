from find_capped_promotion_codes import find_capped_out_codes


def promotion(max_uses=50, current_uses=0, status="ENABLED"):
    return {"id": 1, "max_uses": max_uses, "current_uses": current_uses, "status": status}


def code(id_=1, code="SAVE10", max_uses=500, current_uses=0):
    return {"id": id_, "code": code, "max_uses": max_uses, "current_uses": current_uses}


def test_ok_when_promotion_has_more_room_than_code():
    promo = promotion(max_uses=500, current_uses=10)
    result = find_capped_out_codes(promo, [code(max_uses=50, current_uses=5)])
    assert result[0]["reason"] == "ok"


def test_promotion_exhausted_when_current_uses_reaches_max():
    promo = promotion(max_uses=50, current_uses=50)
    result = find_capped_out_codes(promo, [code(max_uses=500, current_uses=40)])
    assert result[0]["reason"] == "promotion_exhausted"
    assert result[0]["promotion_remaining"] == 0


def test_promotion_cap_lower_than_code_when_code_remaining_exceeds_promotion():
    promo = promotion(max_uses=50, current_uses=40)
    result = find_capped_out_codes(promo, [code(max_uses=500, current_uses=40)])
    assert result[0]["reason"] == "promotion_cap_lower_than_code"
    assert result[0]["promotion_remaining"] == 10
    assert result[0]["code_remaining"] == 460


def test_unlimited_code_flagged_when_promotion_is_capped():
    promo = promotion(max_uses=50, current_uses=10)
    result = find_capped_out_codes(promo, [code(max_uses=0, current_uses=0)])
    assert result[0]["reason"] == "promotion_cap_lower_than_code"
    assert result[0]["code_remaining"] is None


def test_unlimited_promotion_never_gates_a_code():
    promo = promotion(max_uses=0, current_uses=999)
    result = find_capped_out_codes(promo, [code(max_uses=500, current_uses=0)])
    assert result[0]["reason"] == "ok"
    assert result[0]["promotion_remaining"] is None


def test_multiple_codes_are_each_classified_independently():
    promo = promotion(max_uses=50, current_uses=45)
    codes = [code(id_=1, max_uses=10, current_uses=8), code(id_=2, max_uses=500, current_uses=0)]
    result = find_capped_out_codes(promo, codes)
    by_id = {r["code_id"]: r["reason"] for r in result}
    assert by_id[1] == "ok"
    assert by_id[2] == "promotion_cap_lower_than_code"


def test_promotion_exhausted_takes_priority_even_if_code_is_also_unlimited():
    promo = promotion(max_uses=10, current_uses=10)
    result = find_capped_out_codes(promo, [code(max_uses=0, current_uses=0)])
    assert result[0]["reason"] == "promotion_exhausted"
