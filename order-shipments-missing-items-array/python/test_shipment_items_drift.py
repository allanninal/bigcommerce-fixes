from find_shipment_items_drift import find_items_drift


def raw_shipment(items=None, shipment_id=1, order_id=100):
    return {
        "id": shipment_id,
        "order_id": order_id,
        "tracking_number": "1Z999AA10123456784",
        "order_address_id": 5,
        "items": items if items is not None else [
            {"order_product_id": 11, "product_id": 200, "quantity": 2},
        ],
    }


def test_no_drift_when_mapped_items_matches_raw():
    raw = raw_shipment()
    mapped = {"id": 1, "order_id": 100, "items": raw["items"]}
    assert find_items_drift(raw, mapped) is None


def test_no_drift_when_raw_items_is_empty():
    raw = raw_shipment(items=[])
    mapped = {"id": 1, "order_id": 100}
    assert find_items_drift(raw, mapped) is None


def test_drift_when_mapped_items_missing():
    raw = raw_shipment()
    mapped = {"id": 1, "order_id": 100, "tracking_number": "1Z999AA10123456784"}
    drift = find_items_drift(raw, mapped)
    assert drift is not None
    assert drift["shipment_id"] == 1
    assert drift["raw_item_count"] == 1
    assert drift["raw_shipped_quantity"] == 2
    assert drift["order_product_ids"] == [11]


def test_drift_when_mapped_items_is_null():
    raw = raw_shipment()
    mapped = {"id": 1, "order_id": 100, "items": None}
    drift = find_items_drift(raw, mapped)
    assert drift is not None
    assert drift["mapped_items_value"] is None


def test_drift_when_mapped_items_is_empty_list():
    raw = raw_shipment()
    mapped = {"id": 1, "order_id": 100, "items": []}
    drift = find_items_drift(raw, mapped)
    assert drift is not None
    assert drift["mapped_items_value"] == []


def test_sums_quantity_across_multiple_items():
    raw = raw_shipment(items=[
        {"order_product_id": 11, "product_id": 200, "quantity": 2},
        {"order_product_id": 12, "product_id": 201, "quantity": 3},
    ])
    mapped = {"id": 1, "order_id": 100}
    drift = find_items_drift(raw, mapped)
    assert drift["raw_shipped_quantity"] == 5
    assert drift["order_product_ids"] == [11, 12]


def test_no_drift_when_raw_items_missing_key():
    raw = {"id": 1, "order_id": 100}
    mapped = {"id": 1, "order_id": 100}
    assert find_items_drift(raw, mapped) is None


def test_no_drift_when_mapped_items_is_not_a_list():
    raw = raw_shipment()
    mapped = {"id": 1, "order_id": 100, "items": "not-a-list"}
    drift = find_items_drift(raw, mapped)
    assert drift is not None
    assert drift["mapped_items_value"] == "not-a-list"
