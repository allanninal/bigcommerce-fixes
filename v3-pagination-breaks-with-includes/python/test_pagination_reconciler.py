from check_include_pagination import reconcile_paginated_product_ids


def page(ids, total, total_pages, per_page=10):
    return {
        "data": [{"id": i} for i in ids],
        "meta": {"pagination": {"total": total, "total_pages": total_pages, "per_page": per_page}},
    }


def test_trustworthy_when_all_ids_present_and_total_pages_covers_them():
    baseline_ids = [str(i) for i in range(1, 21)]
    pages = [page(range(1, 11), 20, 2), page(range(11, 21), 20, 2)]
    result = reconcile_paginated_product_ids(baseline_ids, pages)
    assert result["missingIds"] == []
    assert result["paginationTrustworthy"] is True
    assert result["recommendedStopCondition"] == "total_pages"


def test_untrustworthy_when_include_pull_is_truncated_by_total_pages():
    baseline_ids = [str(i) for i in range(1, 31)]
    # Requested limit=250 but server capped at 10/page; total_pages wrongly says 1.
    pages = [page(range(1, 11), 30, 1, per_page=10)]
    result = reconcile_paginated_product_ids(baseline_ids, pages)
    assert result["missingIds"] == [str(i) for i in range(11, 31)]
    assert result["paginationTrustworthy"] is False
    assert result["recommendedStopCondition"] == "empty_data_array"


def test_untrustworthy_when_ids_missing_even_if_total_pages_looks_sufficient():
    baseline_ids = [str(i) for i in range(1, 11)]
    pages = [page(range(1, 9), 10, 1, per_page=10)]
    result = reconcile_paginated_product_ids(baseline_ids, pages)
    assert result["missingIds"] == ["9", "10"]
    assert result["paginationTrustworthy"] is False
    assert result["recommendedStopCondition"] == "empty_data_array"


def test_trustworthy_when_baseline_is_empty():
    result = reconcile_paginated_product_ids([], [page([], 0, 0)])
    assert result["missingIds"] == []
    assert result["paginationTrustworthy"] is True
    assert result["recommendedStopCondition"] == "total_pages"


def test_multi_page_include_pull_with_all_ids_covered():
    baseline_ids = [str(i) for i in range(1, 26)]
    pages = [
        page(range(1, 11), 25, 3, per_page=10),
        page(range(11, 21), 25, 3, per_page=10),
        page(range(21, 26), 25, 3, per_page=10),
    ]
    result = reconcile_paginated_product_ids(baseline_ids, pages)
    assert result["missingIds"] == []
    assert result["paginationTrustworthy"] is True
    assert result["recommendedStopCondition"] == "total_pages"
