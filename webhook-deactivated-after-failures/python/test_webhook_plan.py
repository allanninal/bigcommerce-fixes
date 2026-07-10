from reconcile_webhooks import plan_webhook_reconciliation


def desired_entry(scope="store/order/created", destination="https://app.example.com/hooks", **over):
    base = {"scope": scope, "destination": destination, "is_active": True, "headers": {}}
    base.update(over)
    return base


def live_hook(hook_id, scope="store/order/created", destination="https://app.example.com/hooks", is_active=True):
    return {"id": hook_id, "scope": scope, "destination": destination, "is_active": is_active}


def test_healthy_hook_is_left_alone():
    plan = plan_webhook_reconciliation([desired_entry()], [live_hook(1)])
    assert plan == {"toReactivate": [], "toRecreate": [], "toLeave": [1]}


def test_inactive_hook_goes_to_reactivate():
    plan = plan_webhook_reconciliation([desired_entry()], [live_hook(1, is_active=False)])
    assert plan["toReactivate"] == [1]
    assert plan["toRecreate"] == []
    assert plan["toLeave"] == []


def test_missing_hook_goes_to_recreate():
    plan = plan_webhook_reconciliation([desired_entry()], [])
    assert plan["toRecreate"] == [desired_entry()]
    assert plan["toReactivate"] == []
    assert plan["toLeave"] == []


def test_mixed_manifest_preserves_desired_order():
    desired = [
        desired_entry(scope="store/order/created"),
        desired_entry(scope="store/product/updated", destination="https://app.example.com/hooks"),
        desired_entry(scope="store/cart/abandoned", destination="https://app.example.com/hooks"),
    ]
    live = [
        live_hook(1, scope="store/order/created", is_active=True),
        live_hook(2, scope="store/product/updated", is_active=False),
    ]
    plan = plan_webhook_reconciliation(desired, live)
    assert plan["toLeave"] == [1]
    assert plan["toReactivate"] == [2]
    assert plan["toRecreate"] == [desired_entry(scope="store/cart/abandoned", destination="https://app.example.com/hooks")]


def test_does_not_mutate_inputs():
    desired = [desired_entry()]
    live = [live_hook(1, is_active=False)]
    desired_copy = [dict(d) for d in desired]
    live_copy = [dict(h) for h in live]
    plan_webhook_reconciliation(desired, live)
    assert desired == desired_copy
    assert live == live_copy


def test_different_destination_same_scope_counts_as_missing():
    plan = plan_webhook_reconciliation(
        [desired_entry(destination="https://app.example.com/new-hooks")],
        [live_hook(1, destination="https://app.example.com/old-hooks")],
    )
    assert plan["toRecreate"] == [desired_entry(destination="https://app.example.com/new-hooks")]
    assert plan["toReactivate"] == []
    assert plan["toLeave"] == []


def test_empty_desired_yields_all_empty_buckets():
    plan = plan_webhook_reconciliation([], [live_hook(1)])
    assert plan == {"toReactivate": [], "toRecreate": [], "toLeave": []}
