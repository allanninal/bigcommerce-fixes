from decimal import Decimal

from reconcile_refund_state import reconcile_refund_state


def refund_txn(id_="1", amount="25.00", gateway_transaction_id="gw_1", date_created="Wed, 01 Jul 2026 10:00:00 +0000"):
    return {
        "id": id_,
        "amount": Decimal(amount),
        "gateway_transaction_id": gateway_transaction_id,
        "date_created": date_created,
    }


def test_ok_when_totals_match_and_no_duplicates():
    txns = [refund_txn(id_="1", amount="25.00", gateway_transaction_id="gw_1")]
    result = reconcile_refund_state(Decimal("100.00"), Decimal("25.00"), txns)
    assert result["status"] == "ok"
    assert result["discrepancy"] == Decimal("0.00")
    assert result["duplicate_ids"] == []


def test_flag_duplicate_when_same_gateway_transaction_id_appears_twice():
    txns = [
        refund_txn(id_="1", amount="25.00", gateway_transaction_id="gw_1"),
        refund_txn(id_="2", amount="25.00", gateway_transaction_id="gw_1"),
    ]
    result = reconcile_refund_state(Decimal("100.00"), Decimal("50.00"), txns)
    assert result["status"] == "flag_duplicate"
    assert set(result["duplicate_ids"]) == {"1", "2"}


def test_flag_duplicate_when_same_amount_and_overlapping_timestamp():
    txns = [
        refund_txn(id_="1", amount="25.00", gateway_transaction_id="gw_1", date_created="Wed, 01 Jul 2026 10:00:00 +0000"),
        refund_txn(id_="2", amount="25.00", gateway_transaction_id="gw_2", date_created="Wed, 01 Jul 2026 10:00:00 +0000"),
    ]
    result = reconcile_refund_state(Decimal("100.00"), Decimal("50.00"), txns)
    assert result["status"] == "flag_duplicate"
    assert set(result["duplicate_ids"]) == {"1", "2"}


def test_flag_mismatch_when_total_refunded_does_not_match_transaction_sum():
    txns = [refund_txn(id_="1", amount="25.00", gateway_transaction_id="gw_1")]
    result = reconcile_refund_state(Decimal("100.00"), Decimal("40.00"), txns)
    assert result["status"] == "flag_mismatch"
    assert result["discrepancy"] == Decimal("15.00")


def test_ok_when_two_distinct_partial_refunds_sum_correctly():
    txns = [
        refund_txn(id_="1", amount="20.00", gateway_transaction_id="gw_1", date_created="Wed, 01 Jul 2026 09:00:00 +0000"),
        refund_txn(id_="2", amount="30.00", gateway_transaction_id="gw_2", date_created="Wed, 01 Jul 2026 11:00:00 +0000"),
    ]
    result = reconcile_refund_state(Decimal("100.00"), Decimal("50.00"), txns)
    assert result["status"] == "ok"
    assert result["duplicate_ids"] == []


def test_flag_duplicate_takes_precedence_over_mismatch():
    txns = [
        refund_txn(id_="1", amount="25.00", gateway_transaction_id="gw_1"),
        refund_txn(id_="2", amount="25.00", gateway_transaction_id="gw_1"),
    ]
    result = reconcile_refund_state(Decimal("100.00"), Decimal("999.00"), txns)
    assert result["status"] == "flag_duplicate"
