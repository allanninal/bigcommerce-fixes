from restock_declined_orders import decide_restock


def order(**over):
    base = {
        "status_id": 6,
        "already_adjusted": False,
        "products": [{"variant_id": 101, "sku": "ABC-1", "quantity": 2}],
    }
    base.update(over)
    return base


def test_restocks_declined_order_with_no_charge():
    result = decide_restock(order(), [])
    assert result["action"] == "restock"
    assert result["items"] == [{"variant_id": 101, "qty": 2}]


def test_restocks_multiple_line_items():
    products = [
        {"variant_id": 101, "sku": "ABC-1", "quantity": 2},
        {"variant_id": 202, "sku": "ABC-2", "quantity": 1},
    ]
    result = decide_restock(order(products=products), [])
    assert result["action"] == "restock"
    assert result["items"] == [
        {"variant_id": 101, "qty": 2},
        {"variant_id": 202, "qty": 1},
    ]


def test_skips_non_declined_order():
    for status_id in (0, 1, 4, 5, 10, 11):
        result = decide_restock(order(status_id=status_id), [])
        assert result == {"action": "skip", "items": []}


def test_skips_already_adjusted_order():
    result = decide_restock(order(already_adjusted=True), [])
    assert result == {"action": "skip", "items": []}


def test_already_adjusted_wins_over_transactions():
    result = decide_restock(order(already_adjusted=True), [{"status": "approved"}])
    assert result == {"action": "skip", "items": []}


def test_flags_when_transaction_was_approved():
    result = decide_restock(order(), [{"status": "approved"}])
    assert result == {"action": "flag", "items": []}


def test_flags_when_transaction_was_captured():
    result = decide_restock(order(), [{"status": "captured"}])
    assert result == {"action": "flag", "items": []}


def test_flags_when_one_of_several_transactions_is_captured():
    txns = [{"status": "declined"}, {"status": "voided"}, {"status": "captured"}]
    result = decide_restock(order(), txns)
    assert result == {"action": "flag", "items": []}


def test_ignores_declined_transactions():
    result = decide_restock(order(), [{"status": "declined"}])
    assert result["action"] == "restock"


def test_no_transactions_restocks():
    result = decide_restock(order(), [])
    assert result["action"] == "restock"
