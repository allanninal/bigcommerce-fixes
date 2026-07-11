from reconcile_concurrent_inventory_drift import (
    is_inventory_corrupted,
    build_correction_payload,
)


def test_not_corrupted_when_actual_matches_expected():
    assert is_inventory_corrupted(50, 50) is False


def test_not_corrupted_within_tolerance():
    assert is_inventory_corrupted(48, 50, tolerance=2) is False


def test_corrupted_when_actual_drifts_above_tolerance():
    assert is_inventory_corrupted(45, 50, tolerance=2) is True


def test_corrupted_when_actual_is_higher_than_expected():
    assert is_inventory_corrupted(70, 50) is True


def test_not_corrupted_at_exact_tolerance_boundary():
    assert is_inventory_corrupted(52, 50, tolerance=2) is False


def test_correction_payload_has_exact_shape():
    payload = build_correction_payload("SKU-123", 7, 50)
    assert payload == {"location_id": 7, "sku": "SKU-123", "quantity": 50}


def test_correction_payload_uses_expected_on_hand_as_quantity():
    payload = build_correction_payload("SKU-999", 1, 0)
    assert payload["quantity"] == 0
