import pytest

from merge_customers_no_endpoint import plan_customer_merge


def address(id_=1, address1="123 Main St", postal_code="90210", city="Beverly Hills"):
    return {"id": id_, "address1": address1, "postal_code": postal_code, "city": city}


def test_reassigns_every_order_regardless_of_status_id():
    canonical = {"id": 1, "addresses": []}
    duplicate = {
        "id": 2,
        "orders": [
            {"id": 100, "status_id": 10, "total_inc_tax": "50.00"},
            {"id": 101, "status_id": 4, "total_inc_tax": "20.00"},
            {"id": 102, "status_id": 5, "total_inc_tax": "10.00"},
        ],
        "addresses": [],
    }
    plan = plan_customer_merge(canonical, duplicate)
    assert plan["ordersToReassign"] == [100, 101, 102]


def test_skips_duplicate_address_and_creates_new_one():
    canonical = {"id": 1, "addresses": [address(id_=9)]}
    duplicate = {
        "id": 2,
        "orders": [],
        "addresses": [
            address(id_=10, address1="123 Main St", postal_code="90210", city="Beverly Hills"),
            address(id_=11, address1="456 Oak Ave", postal_code="10001", city="New York"),
        ],
    }
    plan = plan_customer_merge(canonical, duplicate)
    assert plan["addressesToSkip"] == [10]
    assert [a["id"] for a in plan["addressesToCreate"]] == [11]


def test_address_match_is_case_insensitive():
    canonical = {"id": 1, "addresses": [address(id_=9, address1="123 MAIN ST", city="BEVERLY HILLS")]}
    duplicate = {"id": 2, "orders": [], "addresses": [address(id_=10, address1="123 main st", city="beverly hills")]}
    plan = plan_customer_merge(canonical, duplicate)
    assert plan["addressesToSkip"] == [10]
    assert plan["addressesToCreate"] == []


def test_duplicate_customer_id_to_deactivate_is_the_duplicate():
    canonical = {"id": 1, "addresses": []}
    duplicate = {"id": 2, "orders": [], "addresses": []}
    plan = plan_customer_merge(canonical, duplicate)
    assert plan["duplicateCustomerIdToDeactivate"] == 2


def test_asserts_duplicate_never_equals_canonical():
    canonical = {"id": 5, "addresses": []}
    duplicate = {"id": 5, "orders": [], "addresses": []}
    with pytest.raises(AssertionError):
        plan_customer_merge(canonical, duplicate)


def test_no_addresses_at_all_returns_empty_lists():
    canonical = {"id": 1, "addresses": []}
    duplicate = {"id": 2, "orders": [], "addresses": []}
    plan = plan_customer_merge(canonical, duplicate)
    assert plan["addressesToCreate"] == []
    assert plan["addressesToSkip"] == []
