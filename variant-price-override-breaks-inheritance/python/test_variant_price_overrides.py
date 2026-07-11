from find_stale_variant_prices import find_stale_variant_overrides


def make_product(price="50.0000"):
    return {"id": 100, "price": price}


def make_variant(variant_id=1, sku="SKU-1", price=None):
    return {"id": variant_id, "sku": sku, "price": price}


def test_no_findings_when_variant_price_is_null():
    product = make_product("50.0000")
    variants = [make_variant(price=None)]
    assert find_stale_variant_overrides(product, variants) == []


def test_no_findings_when_variant_price_is_empty_string():
    product = make_product("50.0000")
    variants = [make_variant(price="")]
    assert find_stale_variant_overrides(product, variants) == []


def test_no_findings_when_variant_price_matches_product_price():
    product = make_product("50.0000")
    variants = [make_variant(price="50.0000")]
    assert find_stale_variant_overrides(product, variants) == []


def test_finding_when_variant_price_diverges():
    product = make_product("50.0000")
    variants = [make_variant(variant_id=7, sku="SKU-7", price="45.0000")]
    result = find_stale_variant_overrides(product, variants)
    assert result == [{
        "variant_id": 7,
        "sku": "SKU-7",
        "product_price": "50.0000",
        "variant_price": "45.0000",
        "delta": "-5.0000",
    }]


def test_finding_delta_is_positive_when_variant_price_is_higher():
    product = make_product("50.0000")
    variants = [make_variant(variant_id=8, sku="SKU-8", price="62.5000")]
    result = find_stale_variant_overrides(product, variants)
    assert result[0]["delta"] == "12.5000"


def test_within_epsilon_is_not_a_finding():
    product = make_product("50.0000")
    variants = [make_variant(price="50.00005")]
    assert find_stale_variant_overrides(product, variants, epsilon="0.0001") == []


def test_just_outside_epsilon_is_a_finding():
    product = make_product("50.0000")
    variants = [make_variant(price="50.0002")]
    result = find_stale_variant_overrides(product, variants, epsilon="0.0001")
    assert len(result) == 1


def test_multiple_variants_only_flags_the_diverging_ones():
    product = make_product("50.0000")
    variants = [
        make_variant(variant_id=1, sku="SKU-1", price=None),
        make_variant(variant_id=2, sku="SKU-2", price="50.0000"),
        make_variant(variant_id=3, sku="SKU-3", price="55.0000"),
    ]
    result = find_stale_variant_overrides(product, variants)
    assert [f["variant_id"] for f in result] == [3]


def test_missing_product_price_returns_no_findings():
    product = {"id": 100}
    variants = [make_variant(price="45.0000")]
    assert find_stale_variant_overrides(product, variants) == []


def test_unparseable_variant_price_is_skipped_not_raised():
    product = make_product("50.0000")
    variants = [make_variant(price="not-a-number")]
    assert find_stale_variant_overrides(product, variants) == []
