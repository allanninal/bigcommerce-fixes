from find_tax_mismatch import find_tax_mismatch, to_cents


def order(total_tax="10.00", order_id=1, status_id=9):
    return {"id": order_id, "total_tax": total_tax, "status_id": status_id}


def tax_row(amount, name="Automatic Tax", rate="8.0000"):
    return {"name": name, "amount": amount, "rate": rate}


def product_row(price_tax, quantity=1, price_ex_tax="50.00"):
    return {"price_tax": price_tax, "quantity": quantity, "price_ex_tax": price_ex_tax}


def test_to_cents_rounds():
    assert to_cents("10.00") == 1000
    assert to_cents("9.99") == 999


def test_exact_match_returns_none():
    result = find_tax_mismatch(order("10.00"), [tax_row("10.00")], [product_row("10.00")])
    assert result is None


def test_one_cent_within_tolerance_returns_none():
    result = find_tax_mismatch(order("10.00"), [tax_row("10.00")], [product_row("10.01")])
    assert result is None


def test_two_cent_mismatch_via_products_sum():
    result = find_tax_mismatch(order("10.02"), [tax_row("10.02")], [product_row("10.00")])
    assert result is not None
    assert result["mismatch"] is True
    assert result["source"] == "products_sum"
    assert result["deltaCents"] == 2


def test_mismatch_via_taxes_endpoint():
    result = find_tax_mismatch(order("10.03"), [tax_row("10.00")], [product_row("10.03")])
    assert result is not None
    assert result["source"] == "taxes_endpoint"
    assert result["deltaCents"] == 3


def test_multi_quantity_line_rounding_flags():
    # three units rounding per line differently than one lump sum
    result = find_tax_mismatch(
        order("2.55"),
        [tax_row("2.52")],
        [product_row("2.55", quantity=3)],
    )
    assert result is not None
    assert result["deltaCents"] == 3


def test_picks_larger_magnitude_source():
    result = find_tax_mismatch(order("10.05"), [tax_row("10.00")], [product_row("10.02")])
    assert result["source"] == "taxes_endpoint"
    assert result["deltaCents"] == 5


def test_no_taxes_or_products_still_mismatches_against_nonzero_total():
    result = find_tax_mismatch(order("5.00"), [], [])
    assert result is not None
    assert result["deltaCents"] == 500
