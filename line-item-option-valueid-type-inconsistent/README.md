# Line item option valueId type is inconsistent across product option types

BigCommerce product options split into two families. Choice-based types (dropdown, radio_buttons, rectangles, swatch, product_list, checkbox) resolve to a catalog `option_value` record with a numeric id. Free-input types (text, multi_line_text, numbers_only_text, date, file) have no `option_values` array at all. The Checkout SDK's `LineItemOption.valueId` reflects that split literally: numeric for choice options, `null` for free-input options, and across SDK/API versions that numeric id is sometimes serialized as a string. A script that forwards `option.valueId` straight into the v2 `POST /v2/orders` `product_options` array (which expects `{id, value}`) breaks: null valueIds get sent as null or omitted, and string-typed ids fail strict type validation, producing "The options of one or more products are invalid." This is corroborated by [bigcommerce/checkout-sdk-js issue #474](https://github.com/bigcommerce/checkout-sdk-js/issues/474), which independently found the exposed `value_id` is not even in the same id-space the order API expects for choice options.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/line-item-option-valueid-type-inconsistent/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python line-item-option-valueid-type-inconsistent/python/normalize_line_item_options.py
node   line-item-option-valueid-type-inconsistent/node/normalize-line-item-options.js
```

`normalize_line_item_option_value` (`normalizeLineItemOptionValue` in Node) is a pure function that takes only a line item option and the product's catalog option values, so it is fully testable without a network call. Free-input types, and any option with a `null` valueId, pass the literal text through untouched. Choice-based types coerce `valueId` to a number, confirm it exists in the catalog, and fall back to a label match on `option.value` before raising `OptionValueUnresolvedError` if nothing matches. The script never guesses a numeric id: unresolved options are logged and flagged, never auto-written into an order. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest line-item-option-valueid-type-inconsistent/python
node --test line-item-option-valueid-type-inconsistent/node
```
