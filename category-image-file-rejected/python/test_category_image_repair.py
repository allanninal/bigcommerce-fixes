from repair_category_images import choose_image_repair_strategy


def test_missing_image_url_with_public_url_uses_put_image_url():
    category = {"id": 42, "image_url": None}
    source = {"public_url": "https://cdn.example.com/cat-42.jpg", "local_file_path": None}
    result = choose_image_repair_strategy(category, source)
    assert result["action"] == "put_image_url"
    assert result["field"] == "image_url"
    assert result["value"] == "https://cdn.example.com/cat-42.jpg"


def test_stale_image_url_differing_from_source_uses_put_image_url():
    category = {"id": 42, "image_url": "https://cdn.example.com/old.jpg"}
    source = {"public_url": "https://cdn.example.com/new.jpg", "local_file_path": None}
    result = choose_image_repair_strategy(category, source)
    assert result["action"] == "put_image_url"
    assert result["value"] == "https://cdn.example.com/new.jpg"


def test_no_public_url_with_local_file_uses_multipart_upload():
    category = {"id": 42, "image_url": None}
    source = {"public_url": None, "local_file_path": "/tmp/cat-42.jpg"}
    result = choose_image_repair_strategy(category, source)
    assert result["action"] == "post_multipart_image"
    assert result["field"] == "image_file"
    assert result["endpoint"] == "/v3/catalog/categories/42/image"


def test_no_source_at_all_flags_for_review():
    category = {"id": 42, "image_url": None}
    source = {"public_url": None, "local_file_path": None}
    result = choose_image_repair_strategy(category, source)
    assert result == {"action": "flag", "reason": "no_image_source_available"}


def test_matching_image_url_with_local_file_still_prefers_no_op_over_json_file_mix():
    category = {"id": 42, "image_url": "https://cdn.example.com/same.jpg"}
    source = {"public_url": "https://cdn.example.com/same.jpg", "local_file_path": "/tmp/cat-42.jpg"}
    result = choose_image_repair_strategy(category, source)
    assert result["action"] == "post_multipart_image"


def test_put_image_url_never_paired_with_image_file_field():
    cases = [
        ({"id": 1, "image_url": None}, {"public_url": "https://cdn.example.com/a.jpg", "local_file_path": None}),
        ({"id": 2, "image_url": "https://cdn.example.com/old.jpg"}, {"public_url": "https://cdn.example.com/new.jpg", "local_file_path": "/tmp/a.jpg"}),
    ]
    for category, source in cases:
        result = choose_image_repair_strategy(category, source)
        assert not (result["action"] == "put_image_url" and result.get("field") == "image_file")
