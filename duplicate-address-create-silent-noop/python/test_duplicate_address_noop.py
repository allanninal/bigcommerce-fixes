from detect_address_noop import classify_address_create_result, find_matched_address_id


def snapshot(ids, total=None):
    id_set = set(ids)
    return {"ids": id_set, "total": total if total is not None else len(id_set)}


def test_created_when_a_new_id_appears():
    pre = snapshot([1, 2])
    post = snapshot([1, 2, 3])
    response = {"status": 201, "data": {"id": 3}}
    assert classify_address_create_result(pre, response, post) == "created"


def test_silent_noop_when_total_and_ids_unchanged_and_no_id_in_data():
    pre = snapshot([1, 2])
    post = snapshot([1, 2])
    response = {"status": 200, "data": []}
    assert classify_address_create_result(pre, response, post) == "silent_noop"


def test_silent_noop_when_data_is_empty_object():
    pre = snapshot([1, 2])
    post = snapshot([1, 2])
    response = {"status": 207, "data": {}}
    assert classify_address_create_result(pre, response, post) == "silent_noop"


def test_error_on_4xx_status():
    pre = snapshot([1, 2])
    post = snapshot([1, 2])
    response = {"status": 422, "data": {}}
    assert classify_address_create_result(pre, response, post) == "error"


def test_error_on_5xx_status():
    pre = snapshot([1, 2])
    post = snapshot([1, 2])
    response = {"status": 500, "data": None}
    assert classify_address_create_result(pre, response, post) == "error"


def test_created_when_data_has_id_even_if_totals_look_equal():
    # Defensive: if the response itself carries an id, trust it as created.
    pre = snapshot([1, 2])
    post = snapshot([1, 2, 3])
    response = {"status": 200, "data": [{"id": 3}]}
    assert classify_address_create_result(pre, response, post) == "created"


def test_find_matched_address_id_returns_the_matching_existing_record():
    existing = [
        {"id": 55, "first_name": "Jamie", "last_name": "Rivera", "company": "",
         "phone": "", "address_type": "residential", "address1": "123 Main St",
         "address2": "", "city": "Austin", "country_code": "US",
         "state_or_province": "Texas", "postal_code": "78701"},
    ]
    attempted = {
        "first_name": "Jamie", "last_name": "Rivera", "company": "", "phone": "",
        "address_type": "residential", "address1": "123 Main St", "address2": "",
        "city": "Austin", "country_code": "US", "state_or_province": "Texas",
        "postal_code": "78701",
    }
    assert find_matched_address_id(existing, attempted) == 55


def test_find_matched_address_id_returns_none_when_no_match():
    existing = [
        {"id": 55, "first_name": "Jamie", "last_name": "Rivera", "address1": "123 Main St",
         "city": "Austin", "country_code": "US", "state_or_province": "Texas", "postal_code": "78701"},
    ]
    attempted = {"first_name": "Alex", "last_name": "Nguyen", "address1": "9 Other Ave",
                 "city": "Dallas", "country_code": "US", "state_or_province": "Texas", "postal_code": "75001"}
    assert find_matched_address_id(existing, attempted) is None
