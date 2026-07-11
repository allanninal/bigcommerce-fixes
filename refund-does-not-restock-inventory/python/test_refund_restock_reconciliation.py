from restock_refunded_inventory import compute_restock_adjustments


def refund_line(refund_item_id="r1:100", order_id=1, product_id=100, variant_id=None, quantity=2):
    return {
        "refund_item_id": refund_item_id,
        "order_id": order_id,
        "product_id": product_id,
        "variant_id": variant_id,
        "quantity": quantity,
    }


def test_restocks_an_unreconciled_unflagged_line():
    result = compute_restock_adjustments([refund_line()], reconciled_ledger=set(), skip_flags={})
    assert result == [{
        "product_id": 100, "variant_id": None, "adjustment": 2,
        "refund_item_id": "r1:100", "order_id": 1,
    }]


def test_skips_a_line_already_in_the_ledger():
    result = compute_restock_adjustments(
        [refund_line()], reconciled_ledger={"r1:100"}, skip_flags={}
    )
    assert result == []


def test_skips_a_line_flagged_non_restockable():
    result = compute_restock_adjustments(
        [refund_line()], reconciled_ledger=set(), skip_flags={"r1:100": True}
    )
    assert result == []


def test_skips_a_line_with_zero_or_negative_quantity():
    result = compute_restock_adjustments(
        [refund_line(quantity=0)], reconciled_ledger=set(), skip_flags={}
    )
    assert result == []

    result_negative = compute_restock_adjustments(
        [refund_line(quantity=-3)], reconciled_ledger=set(), skip_flags={}
    )
    assert result_negative == []


def test_handles_multiple_lines_independently():
    lines = [
        refund_line(refund_item_id="r1:100", product_id=100, quantity=2),
        refund_line(refund_item_id="r1:200", product_id=200, quantity=1),
    ]
    result = compute_restock_adjustments(
        lines, reconciled_ledger={"r1:200"}, skip_flags={}
    )
    assert len(result) == 1
    assert result[0]["product_id"] == 100
    assert result[0]["adjustment"] == 2


def test_preserves_variant_id_when_present():
    result = compute_restock_adjustments(
        [refund_line(variant_id=555)], reconciled_ledger=set(), skip_flags={}
    )
    assert result[0]["variant_id"] == 555


def test_no_adjustments_when_no_refunded_lines():
    result = compute_restock_adjustments([], reconciled_ledger=set(), skip_flags={})
    assert result == []


def test_adjustment_id_and_order_id_pass_through():
    result = compute_restock_adjustments(
        [refund_line(refund_item_id="r9:42", order_id=77, product_id=42, quantity=3)],
        reconciled_ledger=set(),
        skip_flags={},
    )
    assert result[0]["refund_item_id"] == "r9:42"
    assert result[0]["order_id"] == 77
