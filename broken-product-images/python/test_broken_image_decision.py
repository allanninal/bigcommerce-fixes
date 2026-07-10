from find_broken_images import decide_image_action


def image(**over):
    base = {
        "id": 1,
        "image_url": "https://cdn.example.com/a.jpg",
        "url_standard": "https://cdn.example.com/a.jpg",
        "is_thumbnail": False,
        "sort_order": 0,
    }
    base.update(over)
    return base


def test_ok_when_status_is_2xx():
    img = image()
    status = {img["url_standard"]: 200}
    assert decide_image_action(img, status, [img]) == "ok"


def test_flag_only_when_url_missing():
    img = image(url_standard=None, image_url=None)
    assert decide_image_action(img, {}, [img]) == "flag_only"


def test_flag_only_when_url_malformed():
    img = image(url_standard="not-a-url")
    assert decide_image_action(img, {"not-a-url": 404}, [img]) == "flag_only"


def test_clear_reference_when_404_and_not_last_image():
    img = image(id=1)
    sibling = image(id=2, url_standard="https://cdn.example.com/b.jpg")
    status = {img["url_standard"]: 404, sibling["url_standard"]: 200}
    assert decide_image_action(img, status, [img, sibling]) == "clear_reference"


def test_flag_only_when_404_and_only_image_on_product():
    img = image(id=1)
    status = {img["url_standard"]: 404}
    assert decide_image_action(img, status, [img]) == "flag_only"


def test_promote_thumbnail_when_broken_thumbnail_has_good_sibling():
    img = image(id=1, is_thumbnail=True)
    sibling = image(id=2, url_standard="https://cdn.example.com/b.jpg", sort_order=1)
    status = {img["url_standard"]: 403, sibling["url_standard"]: 200}
    assert decide_image_action(img, status, [img, sibling]) == "promote_thumbnail"


def test_clear_reference_when_broken_thumbnail_has_no_good_sibling():
    img = image(id=1, is_thumbnail=True)
    sibling = image(id=2, url_standard="https://cdn.example.com/b.jpg", sort_order=1)
    status = {img["url_standard"]: 404, sibling["url_standard"]: 404}
    assert decide_image_action(img, status, [img, sibling]) == "clear_reference"


def test_flag_only_when_status_is_unreachable_but_not_403_or_404():
    img = image()
    status = {img["url_standard"]: 500}
    assert decide_image_action(img, status, [img]) == "flag_only"


def test_flag_only_when_only_replacement_field_is_image_url_and_missing():
    img = image(url_standard="", image_url=None)
    assert decide_image_action(img, {}, [img]) == "flag_only"


def test_clear_reference_falls_back_to_image_url_when_url_standard_absent():
    img = {"id": 1, "image_url": "https://cdn.example.com/only.jpg", "is_thumbnail": False, "sort_order": 0}
    sibling = image(id=2, url_standard="https://cdn.example.com/b.jpg")
    status = {"https://cdn.example.com/only.jpg": 404, sibling["url_standard"]: 200}
    assert decide_image_action(img, status, [img, sibling]) == "clear_reference"
