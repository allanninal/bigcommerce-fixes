/**
 * Find BigCommerce orders and checkouts whose fulfillment address looks
 * complete but is missing a subfield that trips 422 "A fulfillment address
 * for this order is incomplete" at order-creation or checkout-complete time.
 *
 * POST /v3/checkouts/{checkoutId}/consignments only strictly requires email
 * and country_code on the address plus lineItems, so a consignment can be
 * created successfully with a partial address. POST /v3/orders and checkout
 * complete validate a fuller set of subfields: first_name, last_name,
 * address1, city, state_or_province_code, postal_code, country_code, phone.
 * The missing key, commonly state_or_province_code, postal_code, or phone,
 * or an invalid country_code/country_iso2, is easy to miss because the
 * address object itself is present. This job lists candidate orders
 * (status_id 0 or 11), fetches each stored shipping address, and reports the
 * exact missing or invalid field per order id. It never invents a value; a
 * missing subfield is customer data this script cannot safely guess. Only a
 * narrow, deterministic normalization (a known-good country name to its
 * country_code) is ever written, gated by DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/422-fulfillment-address-incomplete/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE_V2 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const API_BASE_V3 = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const ORDER_STATUS_IDS = (process.env.ORDER_STATUS_IDS || "0,11").split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

const REQUIRED_KEYS = [
  "first_name", "last_name", "address1", "city",
  "state_or_province_code", "postal_code", "country_code", "phone",
];

const ALIASES = {
  address1: ["address1", "street_1"],
  postal_code: ["postal_code", "zip"],
  country_code: ["country_code", "country_iso2"],
  state_or_province_code: ["state_or_province_code", "state_or_province", "state"],
};

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

// Narrow, deterministic country-name to country_code table. Extend only with
// values you have already validated; anything not in here stays flagged.
const KNOWN_COUNTRY_MAP = {
  "united states": "US",
  "united states of america": "US",
  canada: "CA",
  "united kingdom": "GB",
  australia: "AU",
};

function firstPresent(address, key) {
  for (const alias of ALIASES[key] || [key]) {
    const value = address[alias];
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

/**
 * Pure decision. No network, no side effects.
 *
 * For each key in requiredKeys (accepting known aliases), check that the
 * address has a non-empty value under that key or one of its aliases.
 * countryCode/countryIso2 is additionally checked against a 2-letter alpha
 * pattern. Returns the ordered list of the first failing key(s), so the
 * caller can log exactly which subfield would trigger BigCommerce's 422,
 * given no network calls, just the object and the required-key table.
 */
export function findMissingAddressFields(address, requiredKeys = REQUIRED_KEYS) {
  address = address || {};
  const missing = [];
  for (const key of requiredKeys) {
    const value = firstPresent(address, key);
    if (value === null) {
      missing.push(key);
      continue;
    }
    if (key === "country_code" && !COUNTRY_CODE_RE.test(value)) {
      missing.push(key);
    }
  }
  return missing;
}

async function bcGet(base, path, params = {}) {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcPut(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function* candidateOrders() {
  let page = 1;
  while (true) {
    let foundAny = false;
    for (const statusId of ORDER_STATUS_IDS) {
      const orders = await bcGet(API_BASE_V2, "/orders", { status_id: statusId, page, limit: 50 });
      for (const order of orders) {
        foundAny = true;
        yield order;
      }
    }
    if (!foundAny) return;
    page += 1;
  }
}

async function orderShippingAddresses(orderId) {
  return bcGet(API_BASE_V2, `/orders/${orderId}/shippingaddresses`);
}

async function normalizeCountryCode(orderId, addressId, address) {
  const countryName = (address.country || "").trim().toLowerCase();
  const derived = KNOWN_COUNTRY_MAP[countryName];
  if (!derived) return null;

  const before = { country_code: address.country_iso2 || address.country_code };
  const after = { country_code: derived };
  if (DRY_RUN) return { orderId, dryRun: true, before, after };

  await bcPut(API_BASE_V2, `/orders/${orderId}/shippingaddresses/${addressId}`, after);
  return { orderId, dryRun: false, before, after };
}

export async function run() {
  let flagged = 0;
  let clean = 0;

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const addresses = await orderShippingAddresses(orderId);

    for (const address of addresses || []) {
      const missing = findMissingAddressFields(address);
      if (!missing.length) {
        clean += 1;
        continue;
      }

      flagged += 1;
      console.warn(
        `order_id=${orderId} address_id=${address.id} missing_or_invalid_fields=${JSON.stringify(missing)} ` +
        `address_snapshot=${JSON.stringify({
          first_name: address.first_name, last_name: address.last_name, street_1: address.street_1,
          city: address.city, state: address.state, zip: address.zip, country: address.country,
          country_iso2: address.country_iso2, phone: address.phone,
        })}`
      );

      if (missing.includes("country_code")) {
        const result = await normalizeCountryCode(orderId, address.id, address);
        if (result) console.log("country_code normalization:", result);
      }
    }
  }

  console.log(`Done. ${flagged} address(es) flagged, ${clean} address(es) already complete.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
