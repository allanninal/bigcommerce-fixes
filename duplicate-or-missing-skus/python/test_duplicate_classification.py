from find_sku_conflicts import classify_sku_conflicts


def record(id, sku, parent=None):
    return {"id": id, "parentProductId": parent, "sku": sku}


def test_no_conflicts_when_all_unique():
    records = [record(1, "ABC-1"), record(2, "ABC-2"), record(3, "ABC-3")]
    result = classify_sku_conflicts(records)
    assert result["duplicates"] == []
    assert result["missing"] == []


def test_detects_duplicate_case_and_whitespace_insensitive():
    records = [record(1, "ABC-1"), record(2, "  abc-1  "), record(3, "ABC-2")]
    result = classify_sku_conflicts(records)
    assert result["duplicates"] == [{"normalizedSku": "abc-1", "recordIds": [1, 2]}]


def test_detects_missing_sku_for_null_blank_and_whitespace():
    records = [
        record(1, None),
        record(2, ""),
        record(3, "   "),
        record(4, "ABC-9"),
    ]
    result = classify_sku_conflicts(records)
    assert result["duplicates"] == []
    assert result["missing"] == [
        {"id": 1, "parentProductId": None},
        {"id": 2, "parentProductId": None},
        {"id": 3, "parentProductId": None},
    ]


def test_missing_keeps_parent_product_id_for_variants():
    records = [record(55, None, parent=10)]
    result = classify_sku_conflicts(records)
    assert result["missing"] == [{"id": 55, "parentProductId": 10}]


def test_duplicates_sorted_by_normalized_sku_and_missing_by_id():
    records = [
        record(3, None),
        record(1, None),
        record(9, "zzz-1"),
        record(8, "zzz-1"),
        record(6, "aaa-1"),
        record(5, "aaa-1"),
    ]
    result = classify_sku_conflicts(records)
    assert [d["normalizedSku"] for d in result["duplicates"]] == ["aaa-1", "zzz-1"]
    assert [m["id"] for m in result["missing"]] == [1, 3]


def test_three_way_duplicate_groups_all_ids():
    records = [record(1, "DUP-1"), record(2, "DUP-1"), record(3, "DUP-1")]
    result = classify_sku_conflicts(records)
    assert result["duplicates"] == [{"normalizedSku": "dup-1", "recordIds": [1, 2, 3]}]
