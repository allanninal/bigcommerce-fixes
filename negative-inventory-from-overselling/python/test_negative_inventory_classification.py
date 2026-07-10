from fix_negative_inventory import classify_negative_inventory


def product(**over):
    base = {"id": 701, "inventory_tracking": "variant"}
    base.update(over)
    return base


def variant(**over):
    base = {"id": 9001, "sku": "MUG-RED", "inventory_level": -3}
    base.update(over)
    return base


def test_needs_fix_when_variant_tracked_and_negative():
    result = classify_negative_inventory(product(), variant())
    assert result["needsFix"] is True
    assert result["oversoldBy"] == 3
    assert result["sku"] == "MUG-RED"
    assert result["productId"] == 701
    assert result["variantId"] == 9001


def test_no_fix_when_inventory_level_is_zero():
    result = classify_negative_inventory(product(), variant(inventory_level=0))
    assert result["needsFix"] is False
    assert result["oversoldBy"] == 0


def test_no_fix_when_inventory_level_is_positive():
    result = classify_negative_inventory(product(), variant(inventory_level=12))
    assert result["needsFix"] is False


def test_no_fix_when_tracking_is_none():
    result = classify_negative_inventory(product(inventory_tracking="none"), variant())
    assert result["needsFix"] is False
    assert result["oversoldBy"] == 0


def test_no_fix_when_tracking_is_product_level():
    result = classify_negative_inventory(product(inventory_tracking="product"), variant())
    assert result["needsFix"] is False


def test_oversold_by_matches_absolute_value_of_deep_negative():
    result = classify_negative_inventory(product(), variant(inventory_level=-41))
    assert result["needsFix"] is True
    assert result["oversoldBy"] == 41
