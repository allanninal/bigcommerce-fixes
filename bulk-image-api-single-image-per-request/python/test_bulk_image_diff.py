from requeue_missing_images import diff_missing_images, next_sort_order


def persisted(image_url, sort_order=0, id_=1):
    return {"id": id_, "image_url": image_url, "is_thumbnail": False, "sort_order": sort_order}


def test_no_missing_images_when_everything_persisted():
    source = ["https://cdn.example.com/imports/a.jpg", "https://cdn.example.com/imports/b.jpg"]
    persisted_images = [
        persisted("https://cdn.bigcommerce.com/store/products/1/a.jpg", 0),
        persisted("https://cdn.bigcommerce.com/store/products/1/b.jpg", 1),
    ]
    assert diff_missing_images(source, persisted_images) == []


def test_only_first_image_persisted_reports_the_rest_missing():
    source = [
        "https://cdn.example.com/imports/a.jpg",
        "https://cdn.example.com/imports/b.jpg",
        "https://cdn.example.com/imports/c.jpg",
    ]
    persisted_images = [persisted("https://cdn.bigcommerce.com/store/products/1/a.jpg", 0)]
    assert diff_missing_images(source, persisted_images) == [
        "https://cdn.example.com/imports/b.jpg",
        "https://cdn.example.com/imports/c.jpg",
    ]


def test_matching_is_by_normalized_filename_not_exact_url():
    source = ["https://cdn.example.com/imports/A.JPG%20"]
    persisted_images = [persisted("https://cdn.bigcommerce.com/store/products/1/a.jpg", 0)]
    assert diff_missing_images(source, persisted_images) == []


def test_no_persisted_images_means_everything_is_missing():
    source = ["https://cdn.example.com/imports/a.jpg", "https://cdn.example.com/imports/b.jpg"]
    assert diff_missing_images(source, []) == source


def test_preserves_source_order_for_requeuing():
    source = ["https://cdn.example.com/imports/z.jpg", "https://cdn.example.com/imports/a.jpg"]
    assert diff_missing_images(source, []) == source


def test_next_sort_order_continues_after_highest_existing():
    persisted_images = [persisted("a.jpg", 0), persisted("b.jpg", 3)]
    assert next_sort_order(persisted_images) == 4


def test_next_sort_order_starts_at_zero_when_no_images_persisted():
    assert next_sort_order([]) == 0
