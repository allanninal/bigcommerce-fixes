from fix_relative_image_urls import is_fixable_image_url


def test_root_relative_path_is_fixable_with_a_base_url():
    result = is_fixable_image_url("/images/shoe.jpg", "https://cdn.example.com")
    assert result == {"status": "fixable", "resolved_url": "https://cdn.example.com/images/shoe.jpg"}


def test_relative_path_with_no_base_needs_review():
    result = is_fixable_image_url("images/shoe.jpg", None)
    assert result["status"] == "needs_review"
    assert result["resolved_url"] is None


def test_fully_qualified_url_is_already_valid():
    result = is_fixable_image_url("https://cdn.example.com/shoe.jpg", None)
    assert result == {"status": "already_valid", "resolved_url": "https://cdn.example.com/shoe.jpg"}


def test_protocol_relative_url_is_fixable_only_with_a_base_scheme():
    no_base = is_fixable_image_url("//cdn.example.com/shoe.jpg", None)
    assert no_base["status"] == "needs_review"

    with_base = is_fixable_image_url("//cdn.example.com/shoe.jpg", "https://cdn.example.com")
    assert with_base["status"] == "fixable"
    assert with_base["resolved_url"] == "https://cdn.example.com/shoe.jpg"


def test_unsupported_scheme_is_never_fixable():
    result = is_fixable_image_url("ftp://old.example.com/shoe.jpg", "https://cdn.example.com")
    assert result == {"status": "unsupported_scheme", "resolved_url": None}


def test_bare_filename_with_a_base_url_is_fixable():
    result = is_fixable_image_url("shoe.jpg", "https://cdn.example.com/images/")
    assert result["status"] == "fixable"
    assert result["resolved_url"] == "https://cdn.example.com/images/shoe.jpg"


def test_invalid_base_url_falls_back_to_needs_review():
    result = is_fixable_image_url("/images/shoe.jpg", "not-a-real-base")
    assert result["status"] == "needs_review"
    assert result["resolved_url"] is None
