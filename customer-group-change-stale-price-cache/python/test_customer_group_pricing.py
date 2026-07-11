from refresh_stale_group_pricing import is_price_stale


def cart_item(list_price="50.00", sale_price=None):
    return {"list_price": list_price, "sale_price": sale_price}


def price_record(price="50.00", sale_price=None):
    return {"price": price, "sale_price": sale_price}


def test_matching_prices_are_not_stale():
    assert is_price_stale(cart_item(list_price="42.00"), price_record(price="42.00")) is False


def test_stale_when_cart_price_is_higher_than_current_list():
    assert is_price_stale(cart_item(list_price="55.00"), price_record(price="42.00")) is True


def test_stale_when_cart_price_is_lower_than_current_list():
    assert is_price_stale(cart_item(list_price="30.00"), price_record(price="42.00")) is True


def test_prefers_sale_price_on_the_price_list_record():
    record = price_record(price="42.00", sale_price="35.00")
    assert is_price_stale(cart_item(list_price="35.00"), record) is False
    assert is_price_stale(cart_item(list_price="42.00"), record) is True


def test_prefers_sale_price_on_the_cart_line_item():
    item = cart_item(list_price="42.00", sale_price="35.00")
    assert is_price_stale(item, price_record(price="42.00")) is True
    assert is_price_stale(item, price_record(price="35.00")) is False


def test_decimal_string_precision_edge_case_within_tolerance():
    assert is_price_stale(cart_item(list_price="19.999"), price_record(price="20.00")) is False


def test_decimal_string_precision_edge_case_outside_tolerance():
    assert is_price_stale(cart_item(list_price="19.90"), price_record(price="20.00")) is True


def test_both_sides_missing_sale_price_uses_list_and_price():
    assert is_price_stale(cart_item(list_price="10.00", sale_price=None), price_record(price="10.00", sale_price=None)) is False


def test_custom_tolerance_is_respected():
    from decimal import Decimal
    assert is_price_stale(cart_item(list_price="10.05"), price_record(price="10.00"), tolerance=Decimal("0.10")) is False
    assert is_price_stale(cart_item(list_price="10.15"), price_record(price="10.00"), tolerance=Decimal("0.10")) is True
