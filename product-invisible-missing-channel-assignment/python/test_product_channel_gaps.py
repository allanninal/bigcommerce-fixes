from find_missing_channel_assignments import find_missing_channel_assignments


def test_no_gaps_when_every_visible_product_is_assigned():
    catalog_ids = {1, 2}
    visible_ids = {1, 2}
    assignments = {10: {1, 2}, 11: {1, 2}}
    assert find_missing_channel_assignments(catalog_ids, assignments, visible_ids) == []


def test_flags_visible_product_missing_from_one_channel():
    catalog_ids = {1, 2}
    visible_ids = {1, 2}
    assignments = {10: {1, 2}, 11: {1}}
    assert find_missing_channel_assignments(catalog_ids, assignments, visible_ids) == [(2, 11)]


def test_ignores_invisible_products_even_if_missing_everywhere():
    catalog_ids = {1, 2, 3}
    visible_ids = {1, 2}
    assignments = {10: {1, 2}}
    assert find_missing_channel_assignments(catalog_ids, assignments, visible_ids) == []


def test_flags_across_multiple_channels_and_sorts_the_result():
    catalog_ids = {1, 2}
    visible_ids = {1, 2}
    assignments = {20: set(), 10: {1}}
    assert find_missing_channel_assignments(catalog_ids, assignments, visible_ids) == [
        (1, 20), (2, 10), (2, 20),
    ]


def test_no_channels_means_no_gaps():
    catalog_ids = {1, 2}
    visible_ids = {1, 2}
    assert find_missing_channel_assignments(catalog_ids, {}, visible_ids) == []
