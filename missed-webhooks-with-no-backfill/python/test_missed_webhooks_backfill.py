from backfill_missed_webhooks import is_order_missed

WINDOW_START = "2026-07-05T00:00:00+00:00"
WINDOW_END = "2026-07-07T00:00:00+00:00"


def remote(status_id=11, date_modified="2026-07-06T00:00:00+00:00"):
    return {"status_id": status_id, "date_modified": date_modified}


def local(status_id=11, date_modified="2026-07-06T00:00:00+00:00"):
    return {"status_id": status_id, "date_modified": date_modified}


def test_never_seen_order_is_missed():
    assert is_order_missed(None, remote(), WINDOW_START, WINDOW_END) is True


def test_status_changed_is_missed():
    stale = local(status_id=11)
    fresh = remote(status_id=2)
    assert is_order_missed(stale, fresh, WINDOW_START, WINDOW_END) is True


def test_local_older_than_remote_is_missed():
    stale = local(date_modified="2026-07-05T12:00:00+00:00")
    fresh = remote(date_modified="2026-07-06T12:00:00+00:00")
    assert is_order_missed(stale, fresh, WINDOW_START, WINDOW_END) is True


def test_matching_local_state_not_missed():
    same = local(status_id=2, date_modified="2026-07-06T00:00:00+00:00")
    fresh = remote(status_id=2, date_modified="2026-07-06T00:00:00+00:00")
    assert is_order_missed(same, fresh, WINDOW_START, WINDOW_END) is False


def test_outside_window_not_missed():
    outside = remote(date_modified="2026-07-08T00:00:00+00:00")
    assert is_order_missed(None, outside, WINDOW_START, WINDOW_END) is False


def test_before_window_not_missed():
    before = remote(date_modified="2026-07-04T00:00:00+00:00")
    assert is_order_missed(None, before, WINDOW_START, WINDOW_END) is False


def test_local_newer_than_remote_not_missed():
    newer_local = local(status_id=2, date_modified="2026-07-06T12:00:00+00:00")
    older_remote = remote(status_id=2, date_modified="2026-07-06T00:00:00+00:00")
    assert is_order_missed(newer_local, older_remote, WINDOW_START, WINDOW_END) is False


def test_boundary_timestamps_are_inclusive():
    at_start = remote(date_modified=WINDOW_START)
    at_end = remote(date_modified=WINDOW_END)
    assert is_order_missed(None, at_start, WINDOW_START, WINDOW_END) is True
    assert is_order_missed(None, at_end, WINDOW_START, WINDOW_END) is True
