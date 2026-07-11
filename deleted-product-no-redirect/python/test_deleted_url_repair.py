from repair_deleted_url_redirects import plan_redirects

FALLBACK = {"type": "url", "url": "/"}


def test_no_plan_when_nothing_deleted():
    previous = {1: "/old-widget/"}
    assert plan_redirects(previous, {1}, set(), FALLBACK) == []


def test_plans_a_redirect_for_a_deleted_uncovered_url():
    previous = {1: "/old-widget/", 2: "/old-gadget/"}
    plan = plan_redirects(previous, {2}, set(), FALLBACK)
    assert plan == [{"from_path": "/old-widget/", "to": FALLBACK}]


def test_skips_a_deleted_url_already_covered_by_a_redirect():
    previous = {1: "/old-widget/"}
    plan = plan_redirects(previous, set(), {"/old-widget/"}, FALLBACK)
    assert plan == []


def test_handles_multiple_deletions_independently():
    previous = {1: "/old-widget/", 2: "/old-gadget/", 3: "/old-gizmo/"}
    plan = plan_redirects(previous, set(), {"/old-gadget/"}, FALLBACK)
    from_paths = {item["from_path"] for item in plan}
    assert from_paths == {"/old-widget/", "/old-gizmo/"}


def test_empty_previous_snapshot_yields_empty_plan():
    assert plan_redirects({}, {1, 2, 3}, set(), FALLBACK) == []


def test_id_still_live_is_never_included_even_if_url_changed():
    previous = {1: "/old-widget/"}
    plan = plan_redirects(previous, {1}, set(), FALLBACK)
    assert plan == []


def test_fallback_target_passed_through_unmodified():
    previous = {1: "/old-widget/"}
    custom_fallback = {"type": "category", "entity_id": 42}
    plan = plan_redirects(previous, set(), set(), custom_fallback)
    assert plan == [{"from_path": "/old-widget/", "to": custom_fallback}]
