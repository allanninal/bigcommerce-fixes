from find_duplicate_orders import find_duplicate_order_groups


def order(id, customer_id=1, minute=0, second=0, total="49.99", status_id=1, sig="10x1"):
    return {
        "id": id,
        "customer_id": customer_id,
        "date_created": f"Fri, 10 Jul 2026 10:{minute:02d}:{second:02d} +0000",
        "total_inc_tax": total,
        "status_id": status_id,
        "product_signature": sig,
    }


def test_two_close_orders_form_a_duplicate_group():
    orders = [order(1001, second=0), order(1002, second=20)]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == [[1001, 1002]]


def test_orders_far_apart_are_not_grouped():
    orders = [order(1001, minute=0), order(1002, minute=20)]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == []


def test_different_totals_are_not_grouped():
    orders = [order(1001, second=0, total="49.99"), order(1002, second=20, total="59.99")]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == []


def test_different_customers_are_not_grouped():
    orders = [order(1001, customer_id=1, second=0), order(1002, customer_id=2, second=20)]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == []


def test_shipped_orders_are_ignored():
    orders = [order(1001, second=0, status_id=2), order(1002, second=20, status_id=2)]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == []


def test_three_in_a_row_form_one_cluster():
    orders = [order(1001, second=0), order(1002, second=10), order(1003, second=20)]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == [[1001, 1002, 1003]]


def test_different_product_signatures_are_not_grouped():
    orders = [order(1001, second=0, sig="10x1"), order(1002, second=20, sig="11x1")]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == []


def test_keeper_is_the_earliest_order_in_the_cluster():
    orders = [order(1002, second=20), order(1001, second=0)]
    groups = find_duplicate_order_groups(orders, window_seconds=300)
    assert groups == [[1001, 1002]]
