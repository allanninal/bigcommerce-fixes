from reconcile_orphaned_webhooks import classify_hook

NOW = 1_800_000_000
DAY = 86400


def make_hook(client_id="client_unknown", is_active=False, updated_at=NOW):
    return {
        "id": 1,
        "client_id": client_id,
        "scope": "store/order/*",
        "destination": "https://example.com/hooks",
        "is_active": is_active,
        "created_at": updated_at,
        "updated_at": updated_at,
    }


def test_keep_when_client_id_is_known():
    hook = make_hook(client_id="client_known")
    assert classify_hook(hook, {"client_known"}, NOW) == "keep"


def test_orphan_delete_when_unowned_and_stale_inactive():
    hook = make_hook(is_active=False, updated_at=NOW - 91 * DAY)
    assert classify_hook(hook, {"client_known"}, NOW) == "orphan_delete"


def test_orphan_flag_only_when_unowned_and_still_active():
    hook = make_hook(is_active=True, updated_at=NOW - 200 * DAY)
    assert classify_hook(hook, {"client_known"}, NOW) == "orphan_flag_only"


def test_stale_inactive_when_unowned_but_recently_deactivated():
    hook = make_hook(is_active=False, updated_at=NOW - 10 * DAY)
    assert classify_hook(hook, {"client_known"}, NOW) == "stale_inactive"


def test_orphan_delete_respects_custom_stale_after_days():
    hook = make_hook(is_active=False, updated_at=NOW - 31 * DAY)
    assert classify_hook(hook, {"client_known"}, NOW, stale_after_days=30) == "orphan_delete"


def test_keep_wins_even_if_hook_would_otherwise_look_orphaned():
    hook = make_hook(client_id="client_known", is_active=False, updated_at=NOW - 500 * DAY)
    assert classify_hook(hook, {"client_known"}, NOW) == "keep"
