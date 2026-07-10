from backfill_order_metadata import decide_backfill_action

NOW = "2026-07-10T00:00:00+00:00"


def order(**over):
    base = {"status_id": 10, "staff_notes": "", "external_id": "", "external_merchant_id": ""}
    base.update(over)
    return base


def test_skips_incomplete_order():
    result = decide_backfill_action(order(status_id=0), None, NOW)
    assert result == {"action": "skip", "reason": "incomplete_or_voided"}


def test_skips_cancelled_order_even_with_confident_match():
    result = decide_backfill_action(order(status_id=5), {"external_id": "X", "confidence": 0.9}, NOW)
    assert result["action"] == "skip"
    assert result["reason"] == "incomplete_or_voided"


def test_skips_declined_order():
    result = decide_backfill_action(order(status_id=6), None, NOW)
    assert result == {"action": "skip", "reason": "incomplete_or_voided"}


def test_skips_already_tagged_order():
    result = decide_backfill_action(order(staff_notes="prior note\n[RECON:UNMATCHED;checked=x]"), None, NOW)
    assert result == {"action": "skip", "reason": "already_tagged"}


def test_skips_order_with_existing_external_id():
    result = decide_backfill_action(order(external_id="ERP-1"), {"external_id": "ERP-1", "confidence": 0.95}, NOW)
    assert result == {"action": "skip", "reason": "already_has_external_key"}


def test_skips_order_with_existing_external_merchant_id():
    result = decide_backfill_action(order(external_merchant_id="MERCH-1"), None, NOW)
    assert result == {"action": "skip", "reason": "already_has_external_key"}


def test_flags_unmatched_when_no_candidate():
    result = decide_backfill_action(order(), None, NOW)
    assert result["action"] == "flag_unmatched"
    assert result["new_staff_notes"] == f"\n[RECON:UNMATCHED;checked={NOW}]"


def test_flags_unmatched_when_low_confidence():
    result = decide_backfill_action(order(), {"external_id": "ERP-1", "confidence": 0.4}, NOW)
    assert result["action"] == "flag_unmatched"


def test_flags_unmatched_at_exact_boundary_below_threshold():
    result = decide_backfill_action(order(), {"external_id": "ERP-1", "confidence": 0.79}, NOW)
    assert result["action"] == "flag_unmatched"


def test_writes_staff_notes_when_confident():
    candidate = {"external_id": "ERP-00219482", "source": "M-MIG", "confidence": 0.92}
    result = decide_backfill_action(order(), candidate, NOW)
    assert result["action"] == "write_staff_notes"
    assert result["new_staff_notes"] == f"\n[RECON:ext_id=ERP-00219482;source=M-MIG;matched={NOW}]"


def test_writes_staff_notes_at_exact_threshold():
    candidate = {"external_id": "ERP-2", "source": "M-MIG", "confidence": 0.8}
    result = decide_backfill_action(order(), candidate, NOW)
    assert result["action"] == "write_staff_notes"


def test_defaults_source_to_m_mig_when_missing():
    candidate = {"external_id": "ERP-3", "confidence": 0.85}
    result = decide_backfill_action(order(), candidate, NOW)
    assert "source=M-MIG" in result["new_staff_notes"]


def test_appends_rather_than_overwrites_existing_notes():
    candidate = {"external_id": "ERP-9", "source": "M-MIG", "confidence": 0.85}
    result = decide_backfill_action(order(staff_notes="called customer 2026-01-02"), candidate, NOW)
    assert result["new_staff_notes"].startswith("called customer 2026-01-02\n[RECON:")
