from reconcile_coupon_applies_to import plan_coupon_update


def fixture_snapshot(**overrides):
    base = {
        "id": 1,
        "code": "SAVE10",
        "type": "percentage_discount",
        "amount": "10.0000000000",
        "max_uses": 100,
        "num_uses": 42,
        "applies_to": {"entity": "products", "ids": [123, 456]},
    }
    base.update(overrides)
    return base


def test_merges_desired_changes_onto_full_snapshot():
    plan = plan_coupon_update(fixture_snapshot(), {"max_uses": 50})
    assert plan["method"] == "PUT"
    assert plan["path"] == "/coupons/1"
    assert plan["body"]["max_uses"] == 50


def test_body_always_reasserts_applies_to_when_not_in_desired_changes():
    plan = plan_coupon_update(fixture_snapshot(), {"max_uses": 50})
    assert plan["body"]["applies_to"] == {"entity": "products", "ids": [123, 456]}


def test_body_never_omits_untouched_fields():
    plan = plan_coupon_update(fixture_snapshot(), {"max_uses": 50})
    assert plan["body"]["code"] == "SAVE10"
    assert plan["body"]["num_uses"] == 42


def test_wipe_risk_fields_flags_applies_to_when_omitted():
    plan = plan_coupon_update(fixture_snapshot(), {"max_uses": 50})
    assert plan["wipeRiskFields"] == ["applies_to"]


def test_wipe_risk_fields_empty_when_applies_to_is_the_intended_change():
    new_applies_to = {"entity": "categories", "ids": [9]}
    plan = plan_coupon_update(fixture_snapshot(), {"applies_to": new_applies_to})
    assert plan["wipeRiskFields"] == []
    assert plan["body"]["applies_to"] == new_applies_to


def test_body_never_includes_the_id_field():
    plan = plan_coupon_update(fixture_snapshot(), {"max_uses": 50})
    assert "id" not in plan["body"]


def test_raises_when_snapshot_has_no_id():
    import pytest

    with pytest.raises(ValueError):
        plan_coupon_update({"code": "SAVE10"}, {"max_uses": 50})
