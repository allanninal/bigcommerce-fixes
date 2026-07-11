from detect_webhook_gap import detect_webhook_gap

NOW = "2026-07-10T12:00:00Z"


def hook(id_=1, scope="store/order/statusUpdated", is_active=True, destination="https://example.com/hooks"):
    return {"id": id_, "scope": scope, "destination": destination, "is_active": is_active, "updated_at": NOW}


def test_no_findings_when_everything_is_current():
    orders = ["2026-07-10T11:55:00Z"]
    log = {"store/order/statusUpdated": ["2026-07-10T11:56:00Z"]}
    assert detect_webhook_gap(orders, log, [hook()], NOW) == []


def test_flags_deactivated_hook_regardless_of_delivery_log():
    orders = ["2026-07-10T11:55:00Z"]
    log = {"store/order/statusUpdated": ["2026-07-10T11:56:00Z"]}
    findings = detect_webhook_gap(orders, log, [hook(is_active=False)], NOW)
    assert len(findings) == 1
    assert findings[0]["reason"] == "deactivated"
    assert findings[0]["is_active"] is False


def test_flags_stale_active_hook_with_no_recent_delivery():
    orders = ["2026-07-10T11:55:00Z"]
    log = {"store/order/statusUpdated": ["2026-07-10T10:00:00Z"]}
    findings = detect_webhook_gap(orders, log, [hook()], NOW, stale_after_minutes=30)
    assert len(findings) == 1
    assert findings[0]["reason"] == "stale_no_recent_delivery"


def test_no_finding_when_gap_is_within_stale_threshold():
    orders = ["2026-07-10T11:55:00Z"]
    log = {"store/order/statusUpdated": ["2026-07-10T11:45:00Z"]}
    assert detect_webhook_gap(orders, log, [hook()], NOW, stale_after_minutes=30) == []


def test_ignores_hooks_outside_order_and_customer_scope():
    orders = ["2026-07-10T11:55:00Z"]
    log = {}
    findings = detect_webhook_gap(orders, log, [hook(scope="store/product/updated", is_active=False)], NOW)
    assert findings == []


def test_no_findings_when_there_are_no_orders_at_all():
    assert detect_webhook_gap([], {}, [hook()], NOW) == []


def test_flags_customer_scope_hook_too():
    orders = ["2026-07-10T11:55:00Z"]
    log = {}
    findings = detect_webhook_gap(orders, log, [hook(scope="store/customer/created", is_active=False)], NOW)
    assert len(findings) == 1
    assert findings[0]["scope"] == "store/customer/created"


def test_multiple_hooks_only_flags_the_problem_ones():
    orders = ["2026-07-10T11:55:00Z"]
    log = {
        "store/order/statusUpdated": ["2026-07-10T11:56:00Z"],
        "store/order/created": ["2026-07-10T10:00:00Z"],
    }
    hooks = [
        hook(id_=1, scope="store/order/statusUpdated", is_active=True),
        hook(id_=2, scope="store/order/created", is_active=True),
        hook(id_=3, scope="store/order/refunded", is_active=False),
    ]
    findings = detect_webhook_gap(orders, log, hooks, NOW, stale_after_minutes=30)
    ids = sorted(f["hook_id"] for f in findings)
    assert ids == [2, 3]
