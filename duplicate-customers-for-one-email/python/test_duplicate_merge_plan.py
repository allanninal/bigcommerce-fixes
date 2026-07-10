from merge_duplicate_customers import plan_customer_merge


def customer(id, email, date_created):
    return {"id": id, "email": email, "date_created": date_created}


def order(id, customer_id, billing_email):
    return {"id": id, "customer_id": customer_id, "billing_email": billing_email}


def test_no_plan_when_all_emails_unique():
    customers = [customer(1, "a@example.com", "2026-01-01"), customer(2, "b@example.com", "2026-01-01")]
    assert plan_customer_merge(customers, []) == []


def test_survivor_is_earliest_date_created():
    customers = [
        customer(2, "shopper@example.com", "2026-02-01"),
        customer(1, "shopper@example.com", "2026-01-01"),
    ]
    plans = plan_customer_merge(customers, [])
    assert plans == [{"survivorId": 1, "reassignOrderIds": [], "deleteCustomerIds": [2]}]


def test_tie_break_on_lowest_id_when_dates_equal():
    customers = [
        customer(5, "shopper@example.com", "2026-01-01"),
        customer(2, "shopper@example.com", "2026-01-01"),
    ]
    plans = plan_customer_merge(customers, [])
    assert plans[0]["survivorId"] == 2
    assert plans[0]["deleteCustomerIds"] == [5]


def test_matches_email_case_and_whitespace_insensitive():
    customers = [
        customer(1, "Shopper@Example.com", "2026-01-01"),
        customer(2, "  shopper@example.com  ", "2026-01-02"),
    ]
    plans = plan_customer_merge(customers, [])
    assert plans == [{"survivorId": 1, "reassignOrderIds": [], "deleteCustomerIds": [2]}]


def test_single_customer_with_matching_guest_order_produces_no_plan():
    customers = [customer(1, "shopper@example.com", "2026-01-01")]
    orders = [order(100, 0, "shopper@example.com"), order(101, 0, "someone.else@example.com")]
    plans = plan_customer_merge(customers, orders)
    assert plans == []


def test_reassigns_losing_customer_and_guest_orders_onto_survivor():
    customers = [
        customer(1, "shopper@example.com", "2026-01-01"),
        customer(2, "shopper@example.com", "2026-01-05"),
    ]
    orders = [
        order(100, 0, "shopper@example.com"),
        order(101, 2, "shopper@example.com"),
        order(102, 1, "shopper@example.com"),
        order(103, 9, "someone.else@example.com"),
    ]
    plans = plan_customer_merge(customers, orders)
    assert plans == [{"survivorId": 1, "reassignOrderIds": [100, 101], "deleteCustomerIds": [2]}]


def test_ignores_customers_without_an_email():
    customers = [customer(1, "", "2026-01-01"), customer(2, "", "2026-01-01")]
    assert plan_customer_merge(customers, []) == []


def test_never_fuzzy_matches_similar_but_different_emails():
    customers = [customer(1, "shopper@example.com", "2026-01-01"), customer(2, "shoppers@example.com", "2026-01-01")]
    assert plan_customer_merge(customers, []) == []


def test_three_way_cluster_deletes_both_losers():
    customers = [
        customer(3, "shopper@example.com", "2026-03-01"),
        customer(1, "shopper@example.com", "2026-01-01"),
        customer(2, "shopper@example.com", "2026-02-01"),
    ]
    orders = [order(500, 2, "shopper@example.com"), order(501, 3, "shopper@example.com")]
    plans = plan_customer_merge(customers, orders)
    assert plans == [{"survivorId": 1, "reassignOrderIds": [500, 501], "deleteCustomerIds": [2, 3]}]
