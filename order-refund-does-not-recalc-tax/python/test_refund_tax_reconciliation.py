from decimal import Decimal

from reconcile_refund_tax import reconcile_order_tax


def base_order(**overrides):
    order = {"id": 701, "total_tax": "8.00", "total_ex_tax": "100.00", "total_inc_tax": "108.00"}
    order.update(overrides)
    return order


def line_item_refund(amount="50.00", tax_amount="4.00"):
    return {"id": 1, "type": "refund", "item_type": "PRODUCT", "amount": amount, "tax_amount": tax_amount}


def order_level_refund(amount="10.00", tax_amount=None):
    return {"id": 2, "type": "refund", "item_type": "ORDER", "amount": amount, "tax_amount": tax_amount}


def test_reconciled_when_line_item_refund_tax_matches():
    order = base_order(total_tax="4.00")
    record = reconcile_order_tax(order, [line_item_refund(tax_amount="4.00")])
    assert record["flagged"] is False
    assert record["reason"] is None
    assert record["expected_total_tax"] == Decimal("4.00")


def test_flagged_when_order_level_refund_has_zero_tax():
    order = base_order(total_tax="8.00")
    record = reconcile_order_tax(order, [order_level_refund()])
    assert record["flagged"] is True
    assert record["reason"] == "order-level refund skipped tax recalculation"


def test_flagged_when_total_tax_drift_exceeds_tolerance():
    # A non-refund transaction (a chargeback) in the same window carries its own
    # tax_amount, which feeds original_tax but is not backed out of expected_total_tax
    # the way a refund-type transaction is. That mismatch is a genuine total_tax
    # drift, independent of the order-level-zero-tax signature.
    order = base_order(total_tax="8.00")
    txns = [
        line_item_refund(amount="50.00", tax_amount="4.00"),
        {"id": 3, "type": "chargeback", "item_type": "PRODUCT", "amount": "40.00", "tax_amount": "3.00"},
    ]
    record = reconcile_order_tax(order, txns)
    assert record["flagged"] is True
    assert record["reason"] == "total_tax drift"
    assert record["delta"] == Decimal("3.00")


def test_not_flagged_when_delta_within_tolerance():
    order = base_order(total_tax="4.001")
    record = reconcile_order_tax(order, [line_item_refund(tax_amount="4.00")], tolerance=0.01)
    assert record["flagged"] is False


def test_order_id_and_stored_total_tax_pass_through():
    order = base_order(total_tax="8.00")
    record = reconcile_order_tax(order, [line_item_refund(tax_amount="4.00")])
    assert record["order_id"] == 701
    assert record["stored_total_tax"] == Decimal("8.00")


def test_multiple_refund_line_items_are_summed_correctly():
    order = base_order(total_tax="0.00")
    txns = [
        line_item_refund(amount="30.00", tax_amount="2.40"),
        line_item_refund(amount="20.00", tax_amount="1.60"),
    ]
    record = reconcile_order_tax(order, txns)
    assert record["expected_total_tax"] == Decimal("0.00")
    assert record["flagged"] is False


def test_single_line_item_refund_with_no_drift_is_not_flagged():
    order = base_order(total_tax="4.00")
    txns = [line_item_refund(tax_amount="4.00")]
    record = reconcile_order_tax(order, txns)
    assert record["expected_total_tax"] == Decimal("4.00")
    assert record["flagged"] is False
