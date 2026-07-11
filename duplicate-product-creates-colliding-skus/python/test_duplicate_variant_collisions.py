from fix_colliding_variant_skus import find_sku_collisions


def variant(product_id=1, variant_id=1, sku="ABC-1", option_values=None):
    return {
        "product_id": product_id,
        "variant_id": variant_id,
        "sku": sku,
        "option_values": option_values or [],
    }


def test_no_collisions_when_all_skus_are_unique():
    variants = [variant(variant_id=1, sku="ABC-1"), variant(variant_id=2, sku="ABC-2")]
    assert find_sku_collisions(variants) == {}


def test_finds_collision_within_same_product():
    variants = [
        variant(variant_id=1, sku="ABC-1"),
        variant(variant_id=2, sku="ABC-1"),
    ]
    collisions = find_sku_collisions(variants)
    assert list(collisions.keys()) == ["1:abc-1"]
    assert len(collisions["1:abc-1"]) == 2


def test_normalizes_sku_case_and_whitespace():
    variants = [
        variant(variant_id=1, sku="  ABC-1  "),
        variant(variant_id=2, sku="abc-1"),
    ]
    collisions = find_sku_collisions(variants)
    assert len(collisions["1:abc-1"]) == 2


def test_blank_skus_are_not_collisions():
    variants = [variant(variant_id=1, sku=""), variant(variant_id=2, sku="")]
    assert find_sku_collisions(variants) == {}


def test_same_sku_on_different_products_is_not_grouped_together():
    # Collisions are grouped per product_id, so the same SKU text reused on
    # two different single-variant products is not, by itself, a collision.
    # (Each product would need 2+ variants sharing that SKU to be flagged.)
    variants = [
        variant(product_id=1, variant_id=1, sku="ABC-1"),
        variant(product_id=2, variant_id=2, sku="ABC-1"),
    ]
    assert find_sku_collisions(variants) == {}


def test_collision_detected_independently_per_product():
    variants = [
        variant(product_id=1, variant_id=1, sku="ABC-1"),
        variant(product_id=1, variant_id=2, sku="ABC-1"),
        variant(product_id=2, variant_id=3, sku="ABC-1"),
        variant(product_id=2, variant_id=4, sku="ABC-1"),
    ]
    collisions = find_sku_collisions(variants)
    assert "1:abc-1" in collisions
    assert "2:abc-1" in collisions
    assert len(collisions) == 2
    assert len(collisions["1:abc-1"]) == 2
    assert len(collisions["2:abc-1"]) == 2


def test_option_values_are_preserved_for_reporting():
    variants = [
        variant(variant_id=1, sku="ABC-1", option_values=[{"option_display_name": "Color", "label": "Red"}]),
        variant(variant_id=2, sku="ABC-1", option_values=[{"option_display_name": "Color", "label": "Blue"}]),
    ]
    collisions = find_sku_collisions(variants)
    rows = collisions["1:abc-1"]
    assert rows[0]["option_values"][0]["label"] == "Red"
    assert rows[1]["option_values"][0]["label"] == "Blue"


def test_single_variant_group_is_not_a_collision():
    variants = [variant(variant_id=1, sku="ABC-1")]
    assert find_sku_collisions(variants) == {}


def test_only_one_variant_missing_sku_ignored_others_grouped():
    variants = [
        variant(variant_id=1, sku=""),
        variant(variant_id=2, sku="ABC-1"),
        variant(variant_id=3, sku="ABC-1"),
    ]
    collisions = find_sku_collisions(variants)
    assert len(collisions) == 1
    assert len(collisions["1:abc-1"]) == 2
