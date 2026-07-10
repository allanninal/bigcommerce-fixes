from dedupe_webhook_deliveries import classify_webhook_delivery


def payload(**over):
    base = {"scope": "store/order/updated", "hash": "abc123", "created_at": 1000, "producer": "stores/abc"}
    base.update(over)
    return base


def test_new_delivery_is_processed():
    result = classify_webhook_delivery(payload(), set(), 1)
    assert result["action"] == "process"


def test_same_hash_created_at_scope_producer_is_duplicate():
    first = classify_webhook_delivery(payload(), set(), 1)
    seen = {first["deliveryId"]}
    second = classify_webhook_delivery(payload(), seen, 1)
    assert second["deliveryId"] == first["deliveryId"]
    assert second["action"] == "skip_duplicate"


def test_different_created_at_is_a_new_event():
    # simulates the ~2s duplicate-fire case from rapid back-to-back admin edits
    first = classify_webhook_delivery(payload(created_at=1000), set(), 1)
    seen = {first["deliveryId"]}
    second = classify_webhook_delivery(payload(created_at=1002), seen, 1)
    assert second["deliveryId"] != first["deliveryId"]
    assert second["action"] == "process"


def test_fanout_flagged_even_if_never_seen_before():
    # two active hooks on the same scope + destination fan out one event into two deliveries
    result = classify_webhook_delivery(payload(), set(), 2)
    assert result["action"] == "flag_fanout"


def test_fanout_takes_priority_over_duplicate_check():
    first = classify_webhook_delivery(payload(), set(), 1)
    seen = {first["deliveryId"]}
    second = classify_webhook_delivery(payload(), seen, 2)
    assert second["action"] == "flag_fanout"


def test_different_scope_is_a_different_delivery():
    first = classify_webhook_delivery(payload(scope="store/order/updated"), set(), 1)
    seen = {first["deliveryId"]}
    second = classify_webhook_delivery(payload(scope="store/product/updated"), seen, 1)
    assert second["deliveryId"] != first["deliveryId"]
    assert second["action"] == "process"
