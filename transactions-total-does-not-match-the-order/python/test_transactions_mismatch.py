from find_transactions_mismatch import reconcile_order_transactions, to_cents


def order(total_inc_tax="100.00", refunded_amount="0.00"):
    return {"totalIncTax": total_inc_tax, "refundedAmount": refunded_amount}


def txn(amount, type="purchase", success=True):
    return {"type": type, "amount": amount, "success": success}


def test_to_cents_rounds():
    assert to_cents("50.00") == 5000
    assert to_cents("9.99") == 999


def test_exact_match_not_mismatched():
    result = reconcile_order_transactions(order("100.00", "0.00"), [txn("100.00")])
    assert result["isMismatched"] is False
    assert result["diffCents"] == 0


def test_over_refund_is_mismatched():
    # order says 40 net expected, but only a 100 purchase and no refund transaction recorded
    result = reconcile_order_transactions(order("100.00", "60.00"), [txn("100.00")])
    assert result["isMismatched"] is True
    assert result["diffCents"] == 6000


def test_missing_refund_transaction_is_mismatched():
    # refunded_amount says 20 was refunded, but the ledger shows no refund row
    result = reconcile_order_transactions(
        order("100.00", "20.00"),
        [txn("100.00")],
    )
    assert result["isMismatched"] is True
    assert result["diffCents"] == 2000


def test_matching_refund_transaction_ties_out():
    result = reconcile_order_transactions(
        order("100.00", "20.00"),
        [txn("100.00"), txn("20.00", type="refund")],
    )
    assert result["isMismatched"] is False


def test_failed_transaction_ignored():
    result = reconcile_order_transactions(
        order("100.00", "0.00"),
        [txn("100.00"), txn("50.00", type="refund", success=False)],
    )
    assert result["isMismatched"] is False


def test_rounding_at_epsilon_boundary():
    # exactly at epsilon should not trip, one cent over should
    result_at = reconcile_order_transactions(order("100.00", "0.00"), [txn("100.01")], epsilon_cents=1)
    assert result_at["isMismatched"] is False
    result_over = reconcile_order_transactions(order("100.00", "0.00"), [txn("100.02")], epsilon_cents=1)
    assert result_over["isMismatched"] is True
