/**
 * Normalize BigCommerce line item option valueId before building an order payload.
 *
 * BigCommerce product options split into two families. Choice-based types
 * (dropdown, radio_buttons, rectangles, swatch, product_list, checkbox) resolve to
 * a catalog option_value record with a numeric id. Free-input types (text,
 * multi_line_text, numbers_only_text, date, file) have no option_values array at
 * all. The Checkout SDK's LineItemOption.valueId reflects that split literally:
 * numeric for choice options, null for free-input options, and across SDK/API
 * versions that numeric id is sometimes serialized as a string. A script that
 * forwards option.valueId straight into the v2 POST /v2/orders product_options
 * array (which expects {id, value}) breaks: null valueIds get sent as null or
 * omitted, and string-typed ids fail strict type validation, producing
 * "The options of one or more products are invalid." This script cross-references
 * each product's real option_values catalog via GET /v3/catalog/products/{id}/options
 * and /modifiers, walks open and abandoned carts, and reports every mismatch. It
 * never guesses a numeric id; anything unresolved is flagged, never auto-written.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/line-item-option-valueid-type-inconsistent/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FREE_INPUT_TYPES = new Set(["text", "multi_line_text", "numbers_only_text", "date", "file"]);
const CHOICE_TYPES = new Set(["dropdown", "radio_buttons", "rectangles", "swatch", "product_list", "checkbox"]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

export class OptionValueUnresolvedError extends Error {}

async function bcGetV3(path, params = {}) {
  const url = new URL(`${API_BASE_V3}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return body.data || [];
}

async function productOptionValues(productId) {
  // Map every choice-based option's id to its list of {id, label} option_values.
  const byOptionId = {};
  for (const endpoint of ["options", "modifiers"]) {
    const options = await bcGetV3(`/catalog/products/${productId}/${endpoint}`);
    for (const option of options) {
      const values = option.option_values || [];
      byOptionId[option.id] = values.map((v) => ({ id: v.id, label: v.label || "" }));
    }
  }
  return byOptionId;
}

/**
 * Pure decision. No network, no side effects.
 *
 * option: {type, value, valueId, optionId, nameId}
 * catalogOptionValues: list of {id, label} for this option's choices.
 *
 * If option.type is free-input, or valueId is null/undefined, return the
 * literal text passthrough: {id: option.optionId ?? option.nameId, value: String(option.value)}.
 * Otherwise coerce valueId to a number and confirm it exists in
 * catalogOptionValues. If that fails, fall back to a label match on
 * option.value. If nothing matches, throw OptionValueUnresolvedError rather
 * than silently sending a bad id.
 */
export function normalizeLineItemOptionValue(option, catalogOptionValues) {
  const isFreeInput = FREE_INPUT_TYPES.has(option.type);
  const valueId = option.valueId;

  if (isFreeInput || valueId === null || valueId === undefined) {
    return {
      id: option.optionId ?? option.nameId,
      value: String(option.value),
    };
  }

  const numericId = Number(valueId);
  if (!Number.isNaN(numericId)) {
    const byId = catalogOptionValues.find((entry) => entry.id === numericId);
    if (byId) return { id: numericId, value: option.value };
  }

  const byLabel = catalogOptionValues.find((entry) => entry.label === option.value);
  if (byLabel) return { id: byLabel.id, value: option.value };

  throw new OptionValueUnresolvedError(
    `Could not resolve option value id for valueId=${JSON.stringify(valueId)} value=${JSON.stringify(option.value)}`
  );
}

export function findMismatches(cartId, lineItems, optionTypesByProduct) {
  // Flag choice-based options whose valueId is null, empty, or non-numeric.
  const mismatches = [];
  for (const item of lineItems) {
    const productId = item.product_id;
    const optionTypes = optionTypesByProduct[productId] || {};
    for (const option of item.options || []) {
      const optionType = optionTypes[option.nameId] || option.type;
      const valueId = option.valueId;
      const isChoice = CHOICE_TYPES.has(optionType);
      const looksNumeric =
        typeof valueId === "number" || (typeof valueId === "string" && /^\d+$/.test(valueId));
      if (isChoice && !looksNumeric) {
        mismatches.push({
          cart_id: cartId,
          product_id: productId,
          option_id: option.nameId || option.optionId,
          option_type: optionType,
          raw_value_id_typeof: valueId === null ? "null" : typeof valueId,
        });
      }
    }
  }
  return mismatches;
}

async function* candidateCarts() {
  let page = 1;
  while (true) {
    const carts = await bcGetV3("/carts", {
      page,
      limit: 50,
      include: "line_items.physical_items.options,line_items.digital_items.options",
    });
    if (!carts.length) return;
    for (const cart of carts) yield cart;
    page += 1;
  }
}

export async function run() {
  let reported = 0;
  let resolved = 0;
  let unresolved = 0;
  const optionValuesCache = {};

  for await (const cart of candidateCarts()) {
    const cartId = cart.id;
    const lineItems = [
      ...((cart.line_items && cart.line_items.physical_items) || []),
      ...((cart.line_items && cart.line_items.digital_items) || []),
    ];

    const optionTypesByProduct = {};
    for (const item of lineItems) {
      const productId = item.product_id;
      if (!optionValuesCache[productId]) {
        optionValuesCache[productId] = await productOptionValues(productId);
      }
      optionTypesByProduct[productId] = Object.fromEntries(
        Object.keys(optionValuesCache[productId]).map((oid) => [oid, []])
      );
    }

    const mismatches = findMismatches(cartId, lineItems, optionTypesByProduct);
    for (const mismatch of mismatches) {
      console.warn("Mismatch found:", mismatch);
      reported += 1;
    }

    for (const item of lineItems) {
      const productId = item.product_id;
      const catalog = optionValuesCache[productId] || {};
      for (const option of item.options || []) {
        const optionId = option.nameId || option.optionId;
        const valuesForOption = catalog[optionId] || [];
        try {
          const normalized = normalizeLineItemOptionValue(option, valuesForOption);
          console.log(
            `cart_id=${cartId} option_id=${optionId} before=${JSON.stringify(option.valueId)} ` +
            `after=${JSON.stringify(normalized)} (${DRY_RUN ? "dry run" : "resolved"})`
          );
          resolved += 1;
        } catch (err) {
          if (err instanceof OptionValueUnresolvedError) {
            console.warn(`cart_id=${cartId} option_id=${optionId} unresolved: ${err.message}`);
            unresolved += 1;
          } else {
            throw err;
          }
        }
      }
    }
  }

  console.log(
    `Done. ${reported} mismatch(es) reported, ${resolved} option(s) resolved, ${unresolved} option(s) unresolved.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
