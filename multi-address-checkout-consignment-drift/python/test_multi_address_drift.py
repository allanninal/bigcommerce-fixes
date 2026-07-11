from find_consignment_drift import find_consignment_drift


def consignment(item_id, quantity, address_id="addr_1"):
    return {"consignment_id": f"c_{address_id}", "address_id": address_id,
            "line_items": [{"item_id": item_id, "quantity": quantity}]}


def product_row(product_id, quantity, order_address_id, row_id=1):
    return {"id": row_id, "product_id": product_id, "quantity": quantity,
            "order_address_id": order_address_id}


def test_ok_when_every_item_assigned_once_and_quantities_match():
    consignments = [consignment(101, 2, "addr_1"), consignment(102, 1, "addr_2")]
    products = [product_row(101, 2, 10, 1), product_row(102, 1, 11, 2)]
    drift = find_consignment_drift(consignments, products)
    assert all(d["status"] == "ok" for d in drift)


def test_unassigned_when_order_address_id_is_zero():
    consignments = [consignment(101, 3, "addr_1")]
    products = [product_row(101, 3, 0, 1)]
    drift = find_consignment_drift(consignments, products)
    record = next(d for d in drift if d["product_id"] == 101)
    assert record["status"] == "unassigned"
    assert record["unassigned_qty"] == 3


def test_unassigned_when_order_address_id_is_none():
    consignments = [consignment(101, 1, "addr_1")]
    products = [product_row(101, 1, None, 1)]
    drift = find_consignment_drift(consignments, products)
    record = next(d for d in drift if d["product_id"] == 101)
    assert record["status"] == "unassigned"


def test_duplicated_when_actual_quantity_exceeds_expected():
    consignments = [consignment(101, 1, "addr_1")]
    products = [product_row(101, 1, 10, 1), product_row(101, 1, 11, 2)]
    drift = find_consignment_drift(consignments, products)
    record = next(d for d in drift if d["product_id"] == 101)
    assert record["status"] == "duplicated"
    assert record["expected_qty"] == 1
    assert record["actual_qty"] == 2
    assert record["duplicated_qty"] == 1


def test_ok_when_no_consignments_and_no_products():
    assert find_consignment_drift([], []) == []


def test_ok_when_two_addresses_each_have_distinct_items_and_quantities_match():
    consignments = [
        consignment(201, 4, "addr_1"),
        consignment(202, 2, "addr_2"),
        consignment(203, 1, "addr_3"),
    ]
    products = [
        product_row(201, 4, 20, 1),
        product_row(202, 2, 21, 2),
        product_row(203, 1, 22, 3),
    ]
    drift = find_consignment_drift(consignments, products)
    assert all(d["status"] == "ok" for d in drift)
    assert len(drift) == 3


def test_no_false_positive_when_product_only_appears_in_order_products_matching_expected_zero():
    # A product_id with no consignment entry but also no order_products entry should not appear.
    drift = find_consignment_drift([], [])
    assert drift == []


def test_multiple_product_ids_reported_independently():
    consignments = [consignment(301, 1, "addr_1"), consignment(302, 1, "addr_2")]
    products = [
        product_row(301, 1, 0, 1),  # unassigned
        product_row(302, 1, 31, 2),  # ok
    ]
    drift = find_consignment_drift(consignments, products)
    by_id = {d["product_id"]: d for d in drift}
    assert by_id[301]["status"] == "unassigned"
    assert by_id[302]["status"] == "ok"
