from reconcile_customer_id_filter import resolve_customer_lookup


def test_v3_always_ok_even_with_id_filter():
    assert resolve_customer_lookup({"id:in": "123"}, "v3", 200, None) == "ok_list_filter"


def test_v2_success_is_ok_list_filter():
    assert resolve_customer_lookup({"email": "a@b.com"}, "v2", 200, None) == "ok_list_filter"


def test_v2_single_id_400_falls_back_to_direct_resource():
    assert resolve_customer_lookup({"id": "123"}, "v2", 400, "id") == "fallback_direct_resource"


def test_v2_multiple_ids_400_migrates_to_v3():
    assert resolve_customer_lookup({"id": "123,124,125"}, "v2", 400, "id") == "migrate_to_v3"


def test_v2_400_on_unrelated_field_is_ok_list_filter():
    assert resolve_customer_lookup({"sort": "bogus"}, "v2", 400, "sort") == "ok_list_filter"


def test_v2_400_with_no_error_field_is_ok_list_filter():
    assert resolve_customer_lookup({"id": "123"}, "v2", 400, None) == "ok_list_filter"
