from reconcile_b2b_carts import classify_cart_duplicates

NOW = 1_700_000_000
DAY = 86400


def cart(cart_id, customer_id, updated_time, skus):
    return {
        "cart_id": cart_id,
        "customer_id": customer_id,
        "updated_time": updated_time,
        "line_item_skus": frozenset(skus),
    }


def test_single_cart_per_customer_is_not_a_duplicate():
    carts = [cart("A", 1, NOW, ["SKU-1"])]
    assert classify_cart_duplicates(carts, NOW) == {}


def test_anonymous_carts_are_never_grouped():
    carts = [cart("A", 0, NOW, ["SKU-1"]), cart("B", None, NOW, ["SKU-2"])]
    assert classify_cart_duplicates(carts, NOW) == {}


def test_older_subset_cart_is_deletable():
    carts = [
        cart("old", 42, NOW - DAY, ["SKU-1"]),
        cart("new", 42, NOW, ["SKU-1", "SKU-2"]),
    ]
    result = classify_cart_duplicates(carts, NOW)
    assert result["42"]["canonical"] == "new"
    assert result["42"]["orphans_deletable"] == ["old"]
    assert result["42"]["orphans_needs_merge"] == []


def test_older_cart_with_extra_items_needs_merge():
    carts = [
        cart("old", 42, NOW - DAY, ["SKU-1", "SKU-9"]),
        cart("new", 42, NOW, ["SKU-1", "SKU-2"]),
    ]
    result = classify_cart_duplicates(carts, NOW)
    assert result["42"]["canonical"] == "new"
    assert result["42"]["orphans_deletable"] == []
    assert result["42"]["orphans_needs_merge"] == ["old"]


def test_expired_carts_are_dropped_before_grouping():
    carts = [
        cart("stale", 7, NOW - (31 * DAY), ["SKU-1"]),
        cart("only-live", 7, NOW, ["SKU-1"]),
    ]
    assert classify_cart_duplicates(carts, NOW) == {}


def test_three_way_duplicate_group():
    carts = [
        cart("a", 5, NOW - (2 * DAY), ["SKU-1"]),
        cart("b", 5, NOW - DAY, ["SKU-1", "SKU-9"]),
        cart("c", 5, NOW, ["SKU-1", "SKU-2"]),
    ]
    result = classify_cart_duplicates(carts, NOW)
    assert result["5"]["canonical"] == "c"
    assert result["5"]["orphans_deletable"] == ["a"]
    assert result["5"]["orphans_needs_merge"] == ["b"]


def test_exact_duplicate_cart_is_deletable_via_subset_equality():
    carts = [
        cart("old", 9, NOW - DAY, ["SKU-1", "SKU-2"]),
        cart("new", 9, NOW, ["SKU-1", "SKU-2"]),
    ]
    result = classify_cart_duplicates(carts, NOW)
    assert result["9"]["canonical"] == "new"
    assert result["9"]["orphans_deletable"] == ["old"]
    assert result["9"]["orphans_needs_merge"] == []
