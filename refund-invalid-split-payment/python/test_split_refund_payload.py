import pytest

from refund_split_payment import build_split_refund_payload


def test_single_tender_refunds_full_amount_to_one_provider():
    quote = {"refund_methods": [{"provider_id": "gw_a", "amount": "80.00"}]}
    assert build_split_refund_payload(quote, "80.00") == [
        {"provider_id": "gw_a", "amount": "80.00"}
    ]


def test_multi_tender_splits_across_providers_in_order():
    quote = {
        "refund_methods": [
            {"provider_id": "gw_b", "amount": "60.00"},
            {"provider_id": "gw_a", "amount": "20.00"},
        ]
    }
    assert build_split_refund_payload(quote, "80.00") == [
        {"provider_id": "gw_a", "amount": "20.00"},
        {"provider_id": "gw_b", "amount": "60.00"},
    ]


def test_partial_refund_never_exceeds_a_single_methods_max():
    quote = {
        "refund_methods": [
            {"provider_id": "gw_a", "amount": "20.00"},
            {"provider_id": "gw_b", "amount": "60.00"},
        ]
    }
    payload = build_split_refund_payload(quote, "30.00")
    assert payload == [
        {"provider_id": "gw_a", "amount": "20.00"},
        {"provider_id": "gw_b", "amount": "10.00"},
    ]


def test_entries_are_ordered_by_provider_id_even_when_quote_is_unordered():
    quote = {
        "refund_methods": [
            {"provider_id": "gw_z", "amount": "5.00"},
            {"provider_id": "gw_a", "amount": "5.00"},
            {"provider_id": "gw_m", "amount": "5.00"},
        ]
    }
    payload = build_split_refund_payload(quote, "15.00")
    assert [p["provider_id"] for p in payload] == ["gw_a", "gw_m", "gw_z"]


def test_amounts_sum_exactly_to_requested_total():
    quote = {
        "refund_methods": [
            {"provider_id": "gw_a", "amount": "33.33"},
            {"provider_id": "gw_b", "amount": "33.33"},
            {"provider_id": "gw_c", "amount": "33.34"},
        ]
    }
    from decimal import Decimal

    payload = build_split_refund_payload(quote, "100.00")
    total = sum(Decimal(p["amount"]) for p in payload)
    assert total == Decimal("100.00")


def test_raises_on_over_refund_attempt():
    quote = {"refund_methods": [{"provider_id": "gw_a", "amount": "20.00"}]}
    with pytest.raises(ValueError):
        build_split_refund_payload(quote, "20.01")


def test_raises_on_zero_total():
    quote = {"refund_methods": [{"provider_id": "gw_a", "amount": "20.00"}]}
    with pytest.raises(ValueError):
        build_split_refund_payload(quote, "0.00")


def test_raises_on_negative_total():
    quote = {"refund_methods": [{"provider_id": "gw_a", "amount": "20.00"}]}
    with pytest.raises(ValueError):
        build_split_refund_payload(quote, "-5.00")


def test_raises_when_refund_methods_is_empty():
    with pytest.raises(ValueError):
        build_split_refund_payload({"refund_methods": []}, "10.00")


def test_raises_when_refund_methods_key_is_missing():
    with pytest.raises(ValueError):
        build_split_refund_payload({}, "10.00")
