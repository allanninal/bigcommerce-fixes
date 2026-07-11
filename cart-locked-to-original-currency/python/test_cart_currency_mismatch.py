from find_currency_mismatched_carts import find_currency_mismatched_carts


def cart(id_="cart_1", customer_id=None, currency="USD", physical_items=None, is_draft=False):
    return {
        "id": id_,
        "customer_id": customer_id,
        "currency": {"code": currency},
        "line_items": {"physical_items": physical_items or []},
        "base_amount": 50.0,
        "is_draft": is_draft,
    }


def item(discounts=None):
    return {"product_id": 1, "variant_id": None, "quantity": 1, "discounts": discounts or []}


def test_empty_cart_is_never_flagged():
    carts = [cart(currency="USD", physical_items=[])]
    result = find_currency_mismatched_carts(carts, {}, "EUR")
    assert result == []


def test_matching_currency_is_not_flagged():
    carts = [cart(currency="EUR", physical_items=[item()])]
    result = find_currency_mismatched_carts(carts, {}, "EUR")
    assert result == []


def test_mismatched_currency_is_flagged_with_expected_currency():
    carts = [cart(id_="cart_9", customer_id=42, currency="USD", physical_items=[item()])]
    result = find_currency_mismatched_carts(carts, {"42": "EUR"}, "USD")
    assert len(result) == 1
    assert result[0]["id"] == "cart_9"
    assert result[0]["expected_currency"] == "EUR"
    assert result[0]["has_blocking_discount"] is False


def test_guest_cart_falls_back_to_store_default_currency():
    carts = [cart(id_="cart_guest", customer_id=None, currency="USD", physical_items=[item()])]
    result = find_currency_mismatched_carts(carts, {}, "GBP")
    assert len(result) == 1
    assert result[0]["expected_currency"] == "GBP"


def test_draft_cart_is_flagged_as_blocking():
    carts = [cart(id_="cart_draft", customer_id=7, currency="USD", physical_items=[item()], is_draft=True)]
    result = find_currency_mismatched_carts(carts, {"7": "EUR"}, "USD")
    assert len(result) == 1
    assert result[0]["has_blocking_discount"] is True


def test_cart_with_line_item_discount_is_flagged_as_blocking():
    carts = [cart(id_="cart_disc", customer_id=3, currency="USD", physical_items=[item(discounts=[{"id": 1}])])]
    result = find_currency_mismatched_carts(carts, {"3": "EUR"}, "USD")
    assert len(result) == 1
    assert result[0]["has_blocking_discount"] is True


def test_no_action_when_expected_currency_cannot_be_resolved():
    carts = [cart(id_="cart_unknown", customer_id=None, currency="USD", physical_items=[item()])]
    result = find_currency_mismatched_carts(carts, {}, None)
    assert result == []
