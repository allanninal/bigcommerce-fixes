from datetime import datetime, timezone, timedelta

from find_overdue_awaiting_shipment import find_overdue_orders

NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def order(order_id=1, status_id=9, hours_ago=72, has_shipment=False, payment_status="captured"):
    return {
        "id": order_id,
        "status_id": status_id,
        "date_created": (NOW - timedelta(hours=hours_ago)).isoformat(),
        "has_shipment": has_shipment,
        "payment_status": payment_status,
    }


def test_flags_order_past_the_sla():
    result = find_overdue_orders([order(hours_ago=72)], NOW, sla_hours=48)
    assert len(result) == 1
    assert result[0]["order_id"] == 1
    assert result[0]["overage_hours"] == 24


def test_exactly_at_threshold_is_not_overdue():
    result = find_overdue_orders([order(hours_ago=48)], NOW, sla_hours=48)
    assert result == []


def test_already_shipped_but_stale_status_is_excluded():
    result = find_overdue_orders([order(hours_ago=200, has_shipment=True)], NOW, sla_hours=48)
    assert result == []


def test_unpaid_but_wrong_status_id_is_excluded():
    result = find_overdue_orders([order(hours_ago=200, payment_status="uncaptured")], NOW, sla_hours=48)
    assert result == []


def test_multi_status_id_inputs_both_kept():
    orders = [
        order(order_id=1, status_id=9, hours_ago=100),
        order(order_id=2, status_id=11, hours_ago=60),
    ]
    result = find_overdue_orders(orders, NOW, sla_hours=48)
    assert {r["order_id"] for r in result} == {1, 2}


def test_ignores_status_ids_outside_the_target_set():
    result = find_overdue_orders([order(status_id=8, hours_ago=200)], NOW, sla_hours=48)
    assert result == []


def test_sorted_worst_breach_first():
    orders = [
        order(order_id=1, hours_ago=60),   # 12h over
        order(order_id=2, hours_ago=120),  # 72h over
        order(order_id=3, hours_ago=90),   # 42h over
    ]
    result = find_overdue_orders(orders, NOW, sla_hours=48)
    assert [r["order_id"] for r in result] == [2, 3, 1]
