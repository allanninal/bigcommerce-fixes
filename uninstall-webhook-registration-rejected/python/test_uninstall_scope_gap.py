from repair_uninstall_webhook import find_uninstall_scope_gap


def hook(scope, is_active=True, hook_id=1, destination="https://example.com/hook"):
    return {"id": hook_id, "scope": scope, "destination": destination, "is_active": is_active}


def test_missing_when_hooks_list_is_empty():
    assert find_uninstall_scope_gap([]) == {"status": "missing"}


def test_ok_when_exact_scope_is_active():
    hooks = [hook("store/app/uninstalled", is_active=True, hook_id=42)]
    assert find_uninstall_scope_gap(hooks) == {"status": "ok"}


def test_inactive_when_exact_scope_is_not_active():
    hooks = [hook("store/app/uninstalled", is_active=False, hook_id=42)]
    assert find_uninstall_scope_gap(hooks) == {"status": "inactive", "hook_id": 42}


def test_near_miss_when_present_tense_variant_exists():
    hooks = [hook("store/app/uninstall", hook_id=7)]
    assert find_uninstall_scope_gap(hooks) == {
        "status": "near_miss",
        "hook_id": 7,
        "found_scope": "store/app/uninstall",
    }


def test_missing_when_only_unrelated_scopes_exist():
    hooks = [hook("store/order/statusUpdated", hook_id=1), hook("store/cart/updated", hook_id=2)]
    assert find_uninstall_scope_gap(hooks) == {"status": "missing"}


def test_ok_takes_priority_even_if_a_near_miss_also_exists():
    hooks = [hook("store/app/uninstall", hook_id=7), hook("store/app/uninstalled", hook_id=8, is_active=True)]
    assert find_uninstall_scope_gap(hooks) == {"status": "ok"}


def test_inactive_reported_even_when_a_near_miss_is_also_present():
    hooks = [hook("store/app/uninstall", hook_id=7), hook("store/app/uninstalled", hook_id=8, is_active=False)]
    assert find_uninstall_scope_gap(hooks) == {"status": "inactive", "hook_id": 8}


def test_first_near_miss_wins_when_multiple_near_misses_exist():
    hooks = [hook("store/app/uninstall", hook_id=5), hook("app/uninstalled", hook_id=6)]
    assert find_uninstall_scope_gap(hooks) == {
        "status": "near_miss",
        "hook_id": 5,
        "found_scope": "store/app/uninstall",
    }


def test_custom_expected_scope_argument_is_respected():
    hooks = [hook("store/custom/scope", hook_id=9, is_active=True)]
    assert find_uninstall_scope_gap(hooks, expected_scope="store/custom/scope") == {"status": "ok"}
