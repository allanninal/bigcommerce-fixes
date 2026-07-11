from detect_price_list_webhook_gap import diff_price_list_records


def record(price="10.00", sale_price="10.00", retail_price="12.00", map_price="", currency="USD"):
    return {"price": price, "sale_price": sale_price, "retail_price": retail_price,
            "map_price": map_price, "currency": currency}


CATALOG_ONLY = {"store/product/updated", "store/sku/updated"}
CATALOG_AND_PRICE_LIST = {"store/product/updated", "store/priceList/record/updated"}


def test_no_findings_when_nothing_changed():
    previous = {(1, 100): record()}
    current = {(1, 100): record()}
    assert diff_price_list_records(previous, current, CATALOG_ONLY) == []


def test_finds_changed_price_and_flags_webhook_gap_when_only_catalog_scopes_watched():
    previous = {(1, 100): record(price="10.00")}
    current = {(1, 100): record(price="12.00")}
    findings = diff_price_list_records(previous, current, CATALOG_ONLY)
    assert len(findings) == 1
    assert findings[0]["price_list_id"] == 1
    assert findings[0]["variant_id"] == 100
    assert findings[0]["changed_fields"] == ["price"]
    assert findings[0]["webhook_gap"] is True


def test_no_webhook_gap_when_price_list_scope_is_also_registered():
    previous = {(1, 100): record(price="10.00")}
    current = {(1, 100): record(price="12.00")}
    findings = diff_price_list_records(previous, current, CATALOG_AND_PRICE_LIST)
    assert findings[0]["webhook_gap"] is False


def test_no_webhook_gap_when_no_catalog_scopes_are_watched_at_all():
    previous = {(1, 100): record(price="10.00")}
    current = {(1, 100): record(price="12.00")}
    findings = diff_price_list_records(previous, current, set())
    assert findings[0]["webhook_gap"] is False


def test_new_record_counts_as_changed():
    previous = {}
    current = {(2, 200): record()}
    findings = diff_price_list_records(previous, current, CATALOG_ONLY)
    assert len(findings) == 1
    assert findings[0]["price_list_id"] == 2
    assert findings[0]["variant_id"] == 200


def test_multiple_money_fields_are_all_reported():
    previous = {(1, 100): record(price="10.00", sale_price="9.00")}
    current = {(1, 100): record(price="12.00", sale_price="11.00")}
    findings = diff_price_list_records(previous, current, CATALOG_ONLY)
    assert set(findings[0]["changed_fields"]) == {"price", "sale_price"}


def test_no_findings_when_current_is_empty():
    previous = {(1, 100): record()}
    current = {}
    assert diff_price_list_records(previous, current, CATALOG_ONLY) == []


def test_unchanged_currency_field_does_not_trigger_a_finding():
    previous = {(1, 100): record(currency="USD")}
    current = {(1, 100): record(currency="EUR")}
    assert diff_price_list_records(previous, current, CATALOG_ONLY) == []
