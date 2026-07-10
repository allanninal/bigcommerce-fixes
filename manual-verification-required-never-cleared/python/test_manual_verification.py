from clear_manual_verification import decide_clearable


def order(**over):
    base = {"status_id": 12, "staff_notes": "", "date_modified": "2026-07-01T10:00:00Z"}
    base.update(over)
    return base


def msg(text, created_at="2026-07-02T10:00:00Z"):
    return {"message": text, "date_created": created_at}


def test_skip_when_not_status_12():
    assert decide_clearable(order(status_id=11), [], "captured") == "skip"


def test_hold_when_transaction_declined():
    assert decide_clearable(order(staff_notes="Approved by Jane"), [], "declined") == "hold"


def test_hold_when_transaction_void():
    assert decide_clearable(order(staff_notes="Cleared by Jane"), [], "void") == "hold"


def test_hold_when_no_approval_marker():
    assert decide_clearable(order(), [], "captured") == "hold"


def test_clear_when_staff_notes_has_marker_and_transaction_ok():
    assert decide_clearable(order(staff_notes="Verified by Jane on review"), [], "captured") == "clear"


def test_clear_when_message_marker_after_date_modified():
    result = decide_clearable(order(), [msg("Approved after review")], "approved")
    assert result == "clear"


def test_hold_when_message_marker_before_date_modified():
    result = decide_clearable(
        order(date_modified="2026-07-05T10:00:00Z"),
        [msg("Approved earlier", created_at="2026-07-01T09:00:00Z")],
        "captured",
    )
    assert result == "hold"


def test_clear_when_transaction_status_is_none():
    assert decide_clearable(order(staff_notes="Cleared by Jane"), [], None) == "clear"


def test_skip_takes_priority_over_declined_transaction():
    assert decide_clearable(order(status_id=6), [], "declined") == "skip"


def test_marker_is_case_insensitive():
    assert decide_clearable(order(staff_notes="VERIFIED by Jane"), [], "captured") == "clear"
