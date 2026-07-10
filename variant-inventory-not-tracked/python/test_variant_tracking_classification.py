from fix_variant_inventory_tracking import classify_variant_tracking, all_variants_have_stock


def product(**over):
    base = {
        "id": 501,
        "inventory_tracking": "none",
        "variants": [
            {"id": 1, "sku": "SHIRT-S", "inventory_level": 5},
            {"id": 2, "sku": "SHIRT-M", "inventory_level": 3},
        ],
    }
    base.update(over)
    return base


def test_needs_fix_when_tracking_none_with_multiple_variants():
    result = classify_variant_tracking(product())
    assert result["needsFix"] is True
    assert result["reason"] == "tracking_disabled_entirely"
    assert result["affectedVariantIds"] == [1, 2]


def test_needs_fix_when_tracking_product_level():
    result = classify_variant_tracking(product(inventory_tracking="product"))
    assert result["needsFix"] is True
    assert result["reason"] == "tracking_set_to_product_level_not_variant"


def test_no_fix_when_already_tracking_variant():
    result = classify_variant_tracking(product(inventory_tracking="variant"))
    assert result == {"productId": 501, "needsFix": False, "reason": None, "affectedVariantIds": []}


def test_no_fix_when_single_default_variant():
    single = product(variants=[{"id": 1, "sku": "SIMPLE", "inventory_level": 10}])
    result = classify_variant_tracking(single)
    assert result["needsFix"] is False


def test_no_fix_when_no_variants_at_all():
    result = classify_variant_tracking(product(variants=[]))
    assert result["needsFix"] is False


def test_affected_variant_ids_include_every_variant():
    three = product(variants=[
        {"id": 1, "sku": "A", "inventory_level": 1},
        {"id": 2, "sku": "B", "inventory_level": 0},
        {"id": 3, "sku": "C", "inventory_level": None},
    ])
    result = classify_variant_tracking(three)
    assert result["needsFix"] is True
    assert result["affectedVariantIds"] == [1, 2, 3]


def test_tracking_product_level_with_two_variants_needs_fix():
    result = classify_variant_tracking(product(inventory_tracking="product", variants=[
        {"id": 10, "sku": "X", "inventory_level": 0},
        {"id": 11, "sku": "Y", "inventory_level": 2},
    ]))
    assert result["needsFix"] is True
    assert result["reason"] == "tracking_set_to_product_level_not_variant"
    assert result["affectedVariantIds"] == [10, 11]


def test_all_variants_have_stock_true_when_every_variant_has_a_level():
    variants = [
        {"id": 1, "sku": "A", "inventory_level": 5},
        {"id": 2, "sku": "B", "inventory_level": 0},
    ]
    assert all_variants_have_stock(variants, [1, 2]) is True


def test_all_variants_have_stock_false_when_a_variant_is_missing_a_level():
    variants = [
        {"id": 1, "sku": "A", "inventory_level": 5},
        {"id": 2, "sku": "B", "inventory_level": None},
    ]
    assert all_variants_have_stock(variants, [1, 2]) is False


def test_all_variants_have_stock_false_when_variant_id_not_found():
    variants = [{"id": 1, "sku": "A", "inventory_level": 5}]
    assert all_variants_have_stock(variants, [1, 2]) is False
