from check_inventory_overflow import would_overflow_and_be_dropped, VariantLevel

INT32_MAX = 2147483647


def test_safe_when_sum_is_well_under_max():
    levels = [VariantLevel(id=1, level=100), VariantLevel(id=2, level=200)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=2, new_level=300)
    assert is_unsafe is False
    assert projected_sum == 400


def test_unsafe_when_projected_sum_exceeds_int32_max():
    levels = [VariantLevel(id=1, level=2000000000), VariantLevel(id=2, level=100)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=2, new_level=500000000)
    assert is_unsafe is True
    assert projected_sum == 2500000000


def test_unsafe_when_new_level_alone_exceeds_int32_max():
    levels = [VariantLevel(id=1, level=0)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=1, new_level=INT32_MAX + 1)
    assert is_unsafe is True
    assert projected_sum == INT32_MAX + 1


def test_safe_at_exactly_int32_max():
    levels = [VariantLevel(id=1, level=0)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=1, new_level=INT32_MAX)
    assert is_unsafe is False
    assert projected_sum == INT32_MAX


def test_excludes_target_variant_current_level_from_the_sum():
    levels = [VariantLevel(id=1, level=INT32_MAX), VariantLevel(id=2, level=50)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=1, new_level=10)
    assert is_unsafe is False
    assert projected_sum == 60


def test_other_variants_pushing_sum_over_max_is_unsafe():
    levels = [VariantLevel(id=1, level=INT32_MAX - 10), VariantLevel(id=2, level=0)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=2, new_level=11)
    assert is_unsafe is True
    assert projected_sum == INT32_MAX + 1


def test_negative_new_level_reduces_the_projected_sum():
    levels = [VariantLevel(id=1, level=100)]
    is_unsafe, projected_sum = would_overflow_and_be_dropped(levels, variant_id=2, new_level=-50)
    assert is_unsafe is False
    assert projected_sum == 50
