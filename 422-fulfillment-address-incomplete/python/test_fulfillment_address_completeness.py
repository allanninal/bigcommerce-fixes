from find_incomplete_fulfillment_addresses import find_missing_address_fields


def complete_address(**overrides):
    address = {
        "first_name": "Jane",
        "last_name": "Doe",
        "address1": "123 Main St",
        "city": "Austin",
        "state_or_province_code": "TX",
        "postal_code": "78701",
        "country_code": "US",
        "phone": "5125550100",
    }
    address.update(overrides)
    return address


def test_no_missing_fields_on_a_fully_complete_address():
    assert find_missing_address_fields(complete_address()) == []


def test_reports_missing_state_or_province_code():
    address = complete_address(state_or_province_code=None)
    assert find_missing_address_fields(address) == ["state_or_province_code"]


def test_reports_missing_postal_code_when_empty_string():
    address = complete_address(postal_code="")
    assert find_missing_address_fields(address) == ["postal_code"]


def test_reports_missing_phone_when_key_absent_entirely():
    address = complete_address()
    del address["phone"]
    assert find_missing_address_fields(address) == ["phone"]


def test_accepts_zip_and_street_1_and_country_iso2_aliases():
    address = {
        "first_name": "Jane",
        "last_name": "Doe",
        "street_1": "123 Main St",
        "city": "Austin",
        "state": "TX",
        "zip": "78701",
        "country_iso2": "US",
        "phone": "5125550100",
    }
    assert find_missing_address_fields(address) == []


def test_reports_invalid_country_code_that_is_not_two_letters():
    address = complete_address(country_code="USA")
    assert find_missing_address_fields(address) == ["country_code"]


def test_reports_multiple_missing_fields_in_order():
    address = complete_address(postal_code="", phone="")
    assert find_missing_address_fields(address) == ["postal_code", "phone"]


def test_empty_address_reports_every_required_field():
    assert find_missing_address_fields({}) == [
        "first_name", "last_name", "address1", "city",
        "state_or_province_code", "postal_code", "country_code", "phone",
    ]
