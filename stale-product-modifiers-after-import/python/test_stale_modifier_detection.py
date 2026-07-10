from find_stale_modifiers import find_stale_modifiers


def modifier(id, type="text", is_required=False, option_values=None):
    return {"id": id, "type": type, "is_required": is_required, "option_values": option_values or []}


def value(sku=None, product_id=None):
    data = {}
    if sku is not None:
        data["sku"] = sku
    if product_id is not None:
        data["product_id"] = product_id
    return {"value_data": data}


def test_not_stale_when_all_references_are_live():
    mods = [modifier(1, option_values=[value(sku="ABC-1")])]
    assert find_stale_modifiers(mods, {"ABC-1"}, set()) == []


def test_stale_when_sku_missing_from_live_variants():
    mods = [modifier(1, option_values=[value(sku="OLD-SKU")])]
    result = find_stale_modifiers(mods, {"ABC-1"}, set())
    assert result == mods


def test_stale_when_product_list_references_dead_product_id():
    mods = [modifier(2, type="product_list", option_values=[value(product_id=99)])]
    result = find_stale_modifiers(mods, set(), {1, 2, 3})
    assert result == mods


def test_not_stale_when_product_list_references_live_product_id():
    mods = [modifier(2, type="product_list", option_values=[value(product_id=1)])]
    assert find_stale_modifiers(mods, set(), {1, 2, 3}) == []


def test_required_with_zero_option_values_is_stale():
    mods = [modifier(3, is_required=True, option_values=[])]
    assert find_stale_modifiers(mods, set(), set()) == mods


def test_optional_with_zero_option_values_is_not_flagged():
    mods = [modifier(4, is_required=False, option_values=[])]
    assert find_stale_modifiers(mods, set(), set()) == []


def test_ignores_type_other_than_product_list_for_product_id_check():
    mods = [modifier(5, type="text", option_values=[value(product_id=99)])]
    assert find_stale_modifiers(mods, set(), {1, 2, 3}) == []


def test_multiple_modifiers_only_flags_the_stale_one():
    fine = modifier(6, option_values=[value(sku="ABC-1")])
    stale = modifier(7, option_values=[value(sku="GONE")])
    assert find_stale_modifiers([fine, stale], {"ABC-1"}, set()) == [stale]


def test_product_list_with_images_type_is_also_checked():
    mods = [modifier(8, type="product_list_with_images", option_values=[value(product_id=42)])]
    assert find_stale_modifiers(mods, set(), {1, 2, 3}) == mods


def test_multiple_option_values_any_dead_one_flags_modifier():
    mods = [modifier(9, option_values=[value(sku="ABC-1"), value(sku="GONE")])]
    assert find_stale_modifiers(mods, {"ABC-1"}, set()) == mods
