/**
 * Find and, when authorized, migrate BigCommerce carts locked to the wrong currency.
 *
 * A BigCommerce cart's transactional currency is fixed at creation time and stored
 * on the cart object as cart.currency.code. The REST Cart API has no endpoint to
 * mutate the currency of an existing cart. When a shopper switches the storefront
 * currency selector after items are already in the cart, the storefront only
 * updates the display currency, a cookie or session preference, while the
 * underlying cart and checkout keep transacting in the original currency. This
 * job lists open carts, compares each cart's currency against the shopper's
 * selected currency (falling back to the store's default for untracked guest
 * carts), and flags every mismatch. Carts with a manual discount or draft-order
 * status are excluded from auto-migration and only ever reported, since
 * BigCommerce blocks or alters currency changes on those, and any promotion or
 * gift certificate invalid in the new currency is silently dropped when a new
 * cart is rebuilt. Eligible carts are proposed for a guarded migration to a new
 * cart in the correct currency, gated by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/cart-locked-to-original-currency/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CHANNEL_ID = Number(process.env.CHANNEL_ID || 1);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function cartHasLineItems(cart) {
  const lineItems = cart.line_items || {};
  return ["physical_items", "digital_items", "gift_certificates", "custom_items"].some(
    (key) => (lineItems[key] || []).length > 0
  );
}

function cartHasBlockingDiscount(cart) {
  if (cart.is_draft) return true;
  const lineItems = cart.line_items || {};
  return ["physical_items", "digital_items", "custom_items"].some((key) =>
    (lineItems[key] || []).some((item) => (item.discounts || []).length > 0)
  );
}

/**
 * Pure decision logic. No network calls.
 *
 * carts: list of cart dicts as returned by GET /v3/carts/{cartId}, each with
 * {id, customer_id, currency: {code}, line_items, base_amount}.
 *
 * selectedCurrencyByCustomer: map of customer_id (or session/guest id) to the
 * shopper's currently selected storefront currency_code.
 *
 * storeDefaultCurrency: the store's active default currency_code, used as a
 * fallback for guest carts with no tracked selection.
 *
 * Returns the subset of carts (augmented with expected_currency and
 * has_blocking_discount) whose cart.currency.code differs from the shopper's
 * selected currency and that have at least one line item. Empty carts are
 * never flagged.
 */
export function findCurrencyMismatchedCarts(carts, selectedCurrencyByCustomer, storeDefaultCurrency) {
  const flagged = [];
  for (const cart of carts) {
    if (!cartHasLineItems(cart)) continue;

    const key = cart.customer_id ? String(cart.customer_id) : cart.id;
    const expectedCurrency = selectedCurrencyByCustomer[key] || storeDefaultCurrency;
    if (!expectedCurrency) continue;

    const cartCurrency = (cart.currency || {}).code;
    if (cartCurrency === expectedCurrency) continue;

    flagged.push({
      ...cart,
      expected_currency: expectedCurrency,
      has_blocking_discount: cartHasBlockingDiscount(cart),
    });
  }
  return flagged;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function bcDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
}

async function getStoreDefaultCurrency() {
  const currencies = (await bcGet("/currencies")).data || [];
  const defaultCurrency = currencies.find((c) => c.is_default);
  return defaultCurrency ? defaultCurrency.currency_code : null;
}

async function listOpenCarts() {
  const resp = await bcGet("/carts");
  return resp.data || [];
}

function buildMigrationLineItems(cart) {
  const lineItems = cart.line_items || {};
  return {
    line_items: (lineItems.physical_items || []).map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    })),
  };
}

async function migrateCart(cart, channelId) {
  const body = {
    channel_id: channelId,
    currency: { code: cart.expected_currency },
    ...buildMigrationLineItems(cart),
  };
  return bcPost("/carts", body);
}

async function deleteCart(cartId) {
  return bcDelete(`/carts/${cartId}`);
}

export async function run(selectedCurrencyByCustomer = {}) {
  const storeDefaultCurrency = await getStoreDefaultCurrency();
  const carts = await listOpenCarts();

  const mismatched = findCurrencyMismatchedCarts(carts, selectedCurrencyByCustomer, storeDefaultCurrency);

  let migrated = 0;
  let reportedOnly = 0;

  for (const cart of mismatched) {
    const cartId = cart.id;
    console.log(
      `cart_id=${cartId} customer_id=${cart.customer_id} cart_currency=${(cart.currency || {}).code} ` +
      `expected_currency=${cart.expected_currency} has_blocking_discount=${cart.has_blocking_discount}`
    );

    if (cart.has_blocking_discount) {
      console.warn(`cart_id=${cartId} excluded from auto-migration, reporting only.`);
      reportedOnly += 1;
      continue;
    }

    if (DRY_RUN) {
      console.log(`DRY_RUN: would create a replacement cart for cart_id=${cartId} and delete the stale cart.`);
      migrated += 1;
      continue;
    }

    const newCart = await migrateCart(cart, CHANNEL_ID);
    await deleteCart(cartId);
    const newCartId = (newCart.data || {}).id;
    console.log(`cart_id=${cartId} migrated to new_cart_id=${newCartId}`);
    migrated += 1;
  }

  console.log(
    `Done. ${migrated} cart(s) ${DRY_RUN ? "to migrate" : "migrated"}, ${reportedOnly} cart(s) reported only (blocking discount).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
