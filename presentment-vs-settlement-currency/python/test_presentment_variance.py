from find_currency_variance import classify_currency_variance


def order(**over):
    base = {
        "defaultCurrencyCode": "EUR",
        "storeDefaultCurrencyCode": "USD",
        "totalIncTax": "100.00",
        "storeDefaultToTransactionalExchangeRate": "0.90",
        "ledgerBaseAmount": "90.00",
    }
    base.update(over)
    return base


def test_same_currency_is_never_a_mismatch():
    result = classify_currency_variance(
        order(defaultCurrencyCode="USD", storeDefaultCurrencyCode="USD", ledgerBaseAmount="100.00")
    )
    assert result["isMismatch"] is False


def test_matching_conversion_within_tolerance():
    # 100.00 EUR-presented order at rate 0.90 -> 90.00 USD expected, ledger says 90.00
    result = classify_currency_variance(order())
    assert result["isMismatch"] is False
    assert result["expectedBaseAmount"] == 90.0
    assert result["variance"] == 0.0


def test_flags_variance_beyond_tolerance():
    # ledger only shows 85.00 against an expected 90.00, a 5.6% gap
    result = classify_currency_variance(order(ledgerBaseAmount="85.00"))
    assert result["isMismatch"] is True
    assert round(result["varianceRatio"], 4) == round(5.0 / 90.0, 4)


def test_within_tolerance_ratio_not_flagged():
    # ledger shows 89.70, a 0.33% gap, under the default 0.5% tolerance
    result = classify_currency_variance(order(ledgerBaseAmount="89.70"))
    assert result["isMismatch"] is False


def test_custom_tolerance_ratio():
    result = classify_currency_variance(order(ledgerBaseAmount="89.00"), tolerance_ratio=0.001)
    assert result["isMismatch"] is True


def test_presentment_and_settlement_currency_reported():
    result = classify_currency_variance(order(ledgerBaseAmount="85.00"))
    assert result["presentmentCurrency"] == "EUR"
    assert result["settlementCurrency"] == "USD"


def test_zero_total_does_not_divide_by_zero():
    result = classify_currency_variance(
        order(totalIncTax="0", storeDefaultToTransactionalExchangeRate="0.90", ledgerBaseAmount="0")
    )
    assert result["expectedBaseAmount"] == 0.0
    assert result["varianceRatio"] == 0.0
    assert result["isMismatch"] is False
