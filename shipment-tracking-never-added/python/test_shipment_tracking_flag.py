from datetime import datetime, timezone, timedelta

from find_untracked_shipped_orders import find_untracked_shipped_orders

NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def order(order_id=1, status_id=2, hours_ago=48):
    return {
        "id": order_id,
        "status_id": status_id,
        "date_modified": (NOW - timedelta(hours=hours_ago)).isoformat(),
    }


def test_flags_order_with_no_shipment_record():
    result = find_untracked_shipped_orders([order()], {}, NOW)
    assert result == [{"orderId": 1, "reason": "no_shipment_record"}]


def test_flags_order_whose_shipment_has_no_tracking():
    shipments = {1: [{"tracking_number": "", "tracking_link": "", "shipping_provider": ""}]}
    result = find_untracked_shipped_orders([order()], shipments, NOW)
    assert result == [{"orderId": 1, "reason": "shipment_missing_tracking"}]


def test_does_not_flag_order_with_real_tracking():
    shipments = {1: [{"tracking_number": "1Z999", "tracking_link": "", "shipping_provider": "ups"}]}
    result = find_untracked_shipped_orders([order()], shipments, NOW)
    assert result == []


def test_does_not_flag_within_grace_window():
    result = find_untracked_shipped_orders([order(hours_ago=2)], {}, NOW, grace_hours=24)
    assert result == []


def test_ignores_orders_not_in_shipped_like_statuses():
    result = find_untracked_shipped_orders([order(status_id=11)], {}, NOW)
    assert result == []


def test_flags_partially_shipped_and_completed_too():
    orders = [order(order_id=2, status_id=3), order(order_id=3, status_id=10)]
    result = find_untracked_shipped_orders(orders, {}, NOW)
    assert {r["orderId"] for r in result} == {2, 3}


def test_one_shipment_with_tracking_clears_the_order_even_if_another_lacks_it():
    shipments = {
        1: [
            {"tracking_number": "", "tracking_link": "", "shipping_provider": ""},
            {"tracking_number": "1Z999", "tracking_link": "", "shipping_provider": "ups"},
        ]
    }
    result = find_untracked_shipped_orders([order()], shipments, NOW)
    assert result == []


def test_empty_orders_list_returns_empty():
    result = find_untracked_shipped_orders([], {}, NOW)
    assert result == []


def test_missing_shipments_entry_treated_as_no_shipment_record():
    result = find_untracked_shipped_orders([order(order_id=99)], {}, NOW)
    assert result == [{"orderId": 99, "reason": "no_shipment_record"}]
