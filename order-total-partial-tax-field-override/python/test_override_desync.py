from decimal import Decimal

from find_tax_override_desync import find_tax_override_desync


def base_order(**overrides):
    order = {
        "id": 501,
        "total_ex_tax": "100.00",
        "total_inc_tax": "108.00",
        "shipping_cost_inc_tax": "0.00",
        "handling_cost_inc_tax": "0.00",
        "discount_amount": "0.00",
    }
    order.update(overrides)
    return order


def line_item(**overrides):
    item = {
        "id": 9001,
        "price_ex_tax": "100.00",
        "price_inc_tax": "108.00",
        "quantity": 1,
        "total_ex_tax": "100.00",
        "total_inc_tax": "108.00",
    }
    item.update(overrides)
    return item


def test_consistent_order_has_no_findings():
    order = base_order()
    items = [line_item()]
    assert find_tax_override_desync(order, items) == []


def test_order_level_partial_override_is_flagged():
    order = base_order(total_ex_tax="0.00")
    items = [line_item()]
    findings = find_tax_override_desync(order, items)
    reasons = [f["reason"] for f in findings]
    assert "partial_override" in reasons
    order_finding = next(f for f in findings if f["scope"] == "order" and f["reason"] == "partial_override")
    assert order_finding["field_pair"] == ("total_ex_tax", "total_inc_tax")
    assert order_finding["value_a"] == Decimal("0")
    assert order_finding["value_b"] == Decimal("108.00")


def test_line_item_partial_override_is_flagged():
    order = base_order()
    items = [line_item(price_ex_tax=None)]
    findings = find_tax_override_desync(order, items)
    line_finding = next(f for f in findings if f["scope"] == "line_item")
    assert line_finding["field_pair"] == ("price_ex_tax", "price_inc_tax")
    assert line_finding["reason"] == "partial_override"


def test_total_mismatch_is_flagged_beyond_epsilon():
    order = base_order(total_inc_tax="200.00")
    items = [line_item()]
    findings = find_tax_override_desync(order, items)
    mismatch = next(f for f in findings if f["reason"] == "total_mismatch")
    assert mismatch["value_b"] == Decimal("200.00")


def test_rounding_within_epsilon_is_not_flagged():
    order = base_order(total_inc_tax="108.005")
    items = [line_item()]
    findings = find_tax_override_desync(order, items, epsilon=Decimal("0.01"))
    assert all(f["reason"] != "total_mismatch" for f in findings)


def test_no_findings_when_both_sides_are_zero():
    order = base_order(total_ex_tax="0.00", total_inc_tax="0.00")
    items = [line_item(price_ex_tax="0.00", price_inc_tax="0.00", total_ex_tax="0.00", total_inc_tax="0.00")]
    findings = find_tax_override_desync(order, items)
    assert all(f["reason"] != "partial_override" for f in findings)


def test_shipping_and_discount_are_included_in_reconciliation():
    order = base_order(total_inc_tax="118.00", shipping_cost_inc_tax="20.00", discount_amount="10.00")
    items = [line_item()]
    findings = find_tax_override_desync(order, items)
    assert all(f["reason"] != "total_mismatch" for f in findings)
