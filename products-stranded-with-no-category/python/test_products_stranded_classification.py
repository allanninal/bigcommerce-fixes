from fix_stranded_products import is_stranded


def product(**over):
    base = {"id": 501, "name": "Sample Widget", "categories": [12]}
    base.update(over)
    return base


def test_not_stranded_when_it_has_a_category():
    assert is_stranded(product()) is False


def test_stranded_when_categories_is_empty_list():
    assert is_stranded(product(categories=[])) is True


def test_stranded_when_categories_is_missing():
    p = product()
    del p["categories"]
    assert is_stranded(p) is True


def test_stranded_when_categories_is_none():
    assert is_stranded(product(categories=None)) is True


def test_not_stranded_with_multiple_categories():
    assert is_stranded(product(categories=[3, 7, 12])) is False
