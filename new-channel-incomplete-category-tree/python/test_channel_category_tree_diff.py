from backfill_category_tree import diff_category_trees


def node(id_, name, parent_id=None):
    return {"id": id_, "name": name, "parent_id": parent_id}


def test_identical_trees_have_no_missing_nodes():
    primary = [node(1, "Shoes"), node(2, "Boots", parent_id=1)]
    secondary = [node(11, "Shoes"), node(12, "Boots", parent_id=11)]
    assert diff_category_trees(primary, secondary)["missing"] == []


def test_empty_secondary_tree_reports_every_primary_node():
    primary = [node(1, "Shoes"), node(2, "Boots", parent_id=1)]
    missing = diff_category_trees(primary, [])["missing"]
    assert [m["path"] for m in missing] == [["Shoes"], ["Shoes", "Boots"]]


def test_parents_are_listed_before_their_children():
    primary = [
        node(1, "Shoes"),
        node(2, "Boots", parent_id=1),
        node(3, "Winter Boots", parent_id=2),
    ]
    missing = diff_category_trees(primary, [])["missing"]
    depths = [len(m["path"]) for m in missing]
    assert depths == sorted(depths)


def test_reordered_siblings_still_match_by_path():
    primary = [node(1, "Shoes"), node(2, "Boots", parent_id=1), node(3, "Sandals", parent_id=1)]
    secondary = [node(21, "Shoes"), node(22, "Sandals", parent_id=21), node(23, "Boots", parent_id=21)]
    assert diff_category_trees(primary, secondary)["missing"] == []


def test_renamed_parent_causes_children_to_appear_missing():
    primary = [node(1, "Shoes"), node(2, "Boots", parent_id=1)]
    secondary = [node(11, "Footwear"), node(12, "Boots", parent_id=11)]
    missing = diff_category_trees(primary, secondary)["missing"]
    paths = [m["path"] for m in missing]
    assert ["Shoes"] in paths
    assert ["Shoes", "Boots"] in paths


def test_multi_level_gap_reports_only_the_missing_branch():
    primary = [
        node(1, "Shoes"),
        node(2, "Boots", parent_id=1),
        node(3, "Winter Boots", parent_id=2),
    ]
    secondary = [node(11, "Shoes"), node(12, "Boots", parent_id=11)]
    missing = diff_category_trees(primary, secondary)["missing"]
    assert [m["path"] for m in missing] == [["Shoes", "Boots", "Winter Boots"]]


def test_missing_node_parent_path_is_computed_correctly():
    primary = [node(1, "Shoes"), node(2, "Boots", parent_id=1)]
    missing = diff_category_trees(primary, [])["missing"]
    boots = next(m for m in missing if m["name"] == "Boots")
    assert boots["parent_path"] == ["Shoes"]


def test_top_level_node_has_empty_parent_path():
    primary = [node(1, "Shoes")]
    missing = diff_category_trees(primary, [])["missing"]
    assert missing[0]["parent_path"] == []


def test_cyclic_parent_id_does_not_infinite_loop():
    # Defensive: a malformed tree with a cycle should not hang the diff.
    primary = [node(1, "A", parent_id=2), node(2, "B", parent_id=1)]
    result = diff_category_trees(primary, [])
    assert len(result["missing"]) == 2
