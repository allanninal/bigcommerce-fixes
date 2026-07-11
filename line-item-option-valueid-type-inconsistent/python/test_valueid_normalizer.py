import pytest

from normalize_line_item_options import (
    normalize_line_item_option_value,
    OptionValueUnresolvedError,
)

CATALOG = [{"id": 42, "label": "Red"}, {"id": 43, "label": "Blue"}]


def test_free_input_type_passes_literal_text_through():
    option = {"type": "text", "value": "Engrave: Happy Birthday", "valueId": None, "optionId": 9}
    assert normalize_line_item_option_value(option, []) == {
        "id": 9,
        "value": "Engrave: Happy Birthday",
    }


def test_null_valueid_passes_literal_text_through_even_for_choice_type():
    option = {"type": "dropdown", "value": "Red", "valueId": None, "nameId": 5}
    assert normalize_line_item_option_value(option, CATALOG) == {"id": 5, "value": "Red"}


def test_numeric_valueid_resolves_directly():
    option = {"type": "dropdown", "value": "Red", "valueId": 42}
    assert normalize_line_item_option_value(option, CATALOG) == {"id": 42, "value": "Red"}


def test_string_valueid_coerces_and_resolves():
    option = {"type": "swatch", "value": "Blue", "valueId": "43"}
    assert normalize_line_item_option_value(option, CATALOG) == {"id": 43, "value": "Blue"}


def test_stale_numeric_id_falls_back_to_label_match():
    option = {"type": "dropdown", "value": "Red", "valueId": 999}
    assert normalize_line_item_option_value(option, CATALOG) == {"id": 42, "value": "Red"}


def test_unresolved_id_and_label_raises():
    option = {"type": "dropdown", "value": "Green", "valueId": "not-an-id"}
    with pytest.raises(OptionValueUnresolvedError):
        normalize_line_item_option_value(option, CATALOG)


def test_optionid_preferred_over_nameid_for_free_input():
    option = {"type": "file", "value": "logo.png", "valueId": None, "optionId": 7, "nameId": 5}
    assert normalize_line_item_option_value(option, [])["id"] == 7


def test_nameid_used_when_optionid_missing_for_free_input():
    option = {"type": "date", "value": "2026-07-10", "valueId": None, "nameId": 5}
    assert normalize_line_item_option_value(option, [])["id"] == 5
