from recompute_stale_totals import decide_recompute, hash_address


def address(street="123 Main St", city="Austin", state="TX", zip_="78701", country="US"):
    return {"street_1": street, "city": city, "state": state, "zip": zip_, "country_iso2": country}


def test_skip_locked_status_even_if_address_changed():
    order = {"status_id": 2}
    result = decide_recompute(order, address(city="Dallas"), hash_address(address()))
    assert result["action"] == "skip_locked_status"
    assert result["stale_totals"] is False


def test_recompute_when_address_changed_and_totals_unchanged():
    order = {"status_id": 9, "_totals_unchanged_since_snapshot": True}
    result = decide_recompute(order, address(city="Dallas"), hash_address(address()))
    assert result["address_changed"] is True
    assert result["stale_totals"] is True
    assert result["action"] == "recompute"


def test_flag_only_when_address_unchanged():
    same_address = address()
    order = {"status_id": 11, "_totals_unchanged_since_snapshot": True}
    result = decide_recompute(order, same_address, hash_address(same_address))
    assert result["address_changed"] is False
    assert result["stale_totals"] is False
    assert result["action"] == "flag_only"


def test_flag_only_when_address_changed_but_totals_already_moved():
    order = {"status_id": 7, "_totals_unchanged_since_snapshot": False}
    result = decide_recompute(order, address(city="Dallas"), hash_address(address()))
    assert result["address_changed"] is True
    assert result["stale_totals"] is False
    assert result["action"] == "flag_only"


def test_hash_address_is_case_and_whitespace_insensitive():
    a = address(city="Austin")
    b = address(city=" austin ")
    assert hash_address(a) == hash_address(b)


def test_hash_address_changes_when_zip_changes():
    assert hash_address(address(zip_="78701")) != hash_address(address(zip_="90001"))


def test_first_seen_order_with_no_cached_hash_counts_as_changed():
    order = {"status_id": 1, "_totals_unchanged_since_snapshot": True}
    result = decide_recompute(order, address(), None)
    assert result["address_changed"] is True
    assert result["action"] == "recompute"
