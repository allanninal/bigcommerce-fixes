from reconcile_inventory import plan_inventory_reconciliation


def variant(**over):
    base = {"sku": "SKU-1", "inventoryLevel": 10, "inventoryTracking": "variant", "locationId": 1}
    base.update(over)
    return base


def test_no_adjustment_when_counted_matches_inventory_level():
    plan = plan_inventory_reconciliation([variant()], {"SKU-1": 10}, {})
    assert plan == []


def test_skips_sku_with_no_counted_source_of_truth():
    plan = plan_inventory_reconciliation([variant()], {}, {})
    assert plan == []


def test_skips_untracked_variant():
    plan = plan_inventory_reconciliation([variant(inventoryTracking="none")], {"SKU-1": 4}, {})
    assert plan == []


def test_flags_recount_variance_when_no_order_context():
    plan = plan_inventory_reconciliation([variant()], {"SKU-1": 6}, {})
    assert plan == [{"sku": "SKU-1", "locationId": 1, "fromQty": 10, "toQty": 6, "reason": "recount_variance"}]


def test_flags_cancelled_not_restocked_when_order_flag_present():
    flags = {"SKU-1": [{"statusId": 5, "restocked": False}]}
    plan = plan_inventory_reconciliation([variant()], {"SKU-1": 12}, flags)
    assert plan[0]["reason"] == "cancelled_not_restocked"


def test_recount_variance_when_order_was_restocked():
    flags = {"SKU-1": [{"statusId": 5, "restocked": True}]}
    plan = plan_inventory_reconciliation([variant()], {"SKU-1": 12}, flags)
    assert plan[0]["reason"] == "recount_variance"


def test_recount_variance_when_status_not_a_restock_status():
    flags = {"SKU-1": [{"statusId": 11, "restocked": False}]}
    plan = plan_inventory_reconciliation([variant()], {"SKU-1": 12}, flags)
    assert plan[0]["reason"] == "recount_variance"


def test_matches_any_of_the_four_restock_statuses():
    for status_id in (4, 5, 6, 14):
        flags = {"SKU-1": [{"statusId": status_id, "restocked": False}]}
        plan = plan_inventory_reconciliation([variant()], {"SKU-1": 3}, flags)
        assert plan[0]["reason"] == "cancelled_not_restocked", status_id


def test_multiple_variants_only_drifted_ones_emitted():
    variants = [variant(sku="A", inventoryLevel=5), variant(sku="B", inventoryLevel=5)]
    counted = {"A": 5, "B": 2}
    plan = plan_inventory_reconciliation(variants, counted, {})
    assert len(plan) == 1
    assert plan[0]["sku"] == "B"
    assert plan[0]["toQty"] == 2


def test_location_id_carried_through():
    plan = plan_inventory_reconciliation([variant(locationId=7)], {"SKU-1": 1}, {})
    assert plan[0]["locationId"] == 7
