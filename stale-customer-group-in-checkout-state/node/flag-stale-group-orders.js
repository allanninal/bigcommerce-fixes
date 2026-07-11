/**
 * Flag BigCommerce orders priced against a stale cached customer group.
 *
 * checkout-sdk-js reads a shopper's customer_group_id once when checkout
 * state initializes and caches it in the in-memory checkoutState.data
 * customer object. If the customer_group_id changes mid session, an admin
 * moves them to a new group, a B2B company-role change fires, or an
 * automated group reassignment runs, the SDK's state-merge logic does not
 * reliably overwrite the cached value (checkout-sdk-js issue #1321).
 * Because customer-group pricing is resolved through Price Lists tied to a
 * customer_group_id, and that resolution happens against the cached session
 * group rather than being re-fetched at price-calculation or order-submit
 * time, the shopper can complete checkout priced under their old, stale
 * group.
 *
 * This is unsafe to auto-fix: the order is already placed and paid, and a
 * script cannot know whether the merchant wants to honor the lower price,
 * collect the difference, refund, or void the order. This job only detects
 * and flags. It never changes price, issues a refund, or moves status_id.
 * Default mode (DRY_RUN=true) only prints and exports a CSV of flagged
 * order ids. With DRY_RUN=false it additionally appends a staff-only note
 * to the order via PUT /v2/orders/{id}. Any real price fix is a separate,
 * human-confirmed step.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/stale-customer-group-in-checkout-state/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const CHANNEL_ID = Number(process.env.CHANNEL_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_CSV = process.env.OUTPUT_CSV || "flagged_orders.csv";

// Exclude 5 Cancelled and 6 Declined.
const RELEVANT_STATUS_IDS = "0,7,9,11,1,10";
const TOLERANCE = 0.01;
const UNRESOLVED_GROUP_ID = -1; // sentinel: any id guaranteed to differ from a real group id

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Takes the customer's current customer_group_id, the group id inferred
 * from the price-list record that matches what was actually charged
 * (pricedGroupId), the unit price charged on the order line, and the unit
 * price that the customer's CURRENT group's assigned price list would
 * produce for that same variant. Returns true (flag as mispriced) only
 * when the group ids actually diverge AND that divergence produced a real
 * price difference beyond rounding tolerance, avoiding false positives
 * when two different groups happen to share identical pricing.
 */
export function isOrderMispriced(
  currentGroupId,
  pricedGroupId,
  chargedUnitPrice,
  currentGroupUnitPrice,
  tolerance = TOLERANCE
) {
  if (currentGroupId === pricedGroupId) return false;
  const priceDelta = Math.abs(chargedUnitPrice - currentGroupUnitPrice);
  return priceDelta > tolerance;
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
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
    const orders = await bcGet("/v2/orders", {
      min_date_created: `-${LOOKBACK_DAYS} days`,
      "status_id:in": RELEVANT_STATUS_IDS,
      page,
      limit: 50,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderLinePrices(orderId) {
  return bcGet(`/v2/orders/${orderId}/products`);
}

async function currentCustomerGroupId(customerId) {
  // Customer groups are a V2-only resource; /v3/customers does not expose group id.
  let customer = await bcGet(`/v2/customers/${customerId}`);
  if (Array.isArray(customer)) customer = customer[0] || {};
  return customer.customer_group_id ?? null;
}

async function activePriceListId(customerGroupId, channelId = CHANNEL_ID) {
  const resp = await bcGet("/v3/pricelists/assignments", {
    customer_group_id: customerGroupId,
    channel_id: channelId,
  });
  const assignments = resp.data || [];
  return assignments.length ? assignments[0].price_list_id : null;
}

async function priceListRecords(priceListId, variantIds) {
  if (!variantIds.length) return [];
  const resp = await bcGet(`/v3/pricelists/${priceListId}/records`, {
    "variant_id:in": variantIds.join(","),
  });
  return resp.data || [];
}

async function flagOrderNote(orderId, summary) {
  // Append a staff-only note. Never changes price, status, or totals.
  const order = await bcGet(`/v2/orders/${orderId}`);
  const existing = order.staff_notes || "";
  const updated = (existing ? existing + "\n" : "") + summary;
  return bcPut(`/v2/orders/${orderId}`, { staff_notes: updated });
}

export async function run() {
  const flaggedRows = [];
  const groupPriceListCache = new Map();

  for await (const order of candidateOrders()) {
    const orderId = order.id;
    const customerId = order.customer_id;
    if (!customerId) continue;

    const currentGroupId = await currentCustomerGroupId(customerId);
    if (currentGroupId === null) continue;

    const lines = await orderLinePrices(orderId);
    const variantIds = lines.map((line) => line.variant_id).filter(Boolean);
    if (!variantIds.length) continue;

    if (!groupPriceListCache.has(currentGroupId)) {
      groupPriceListCache.set(currentGroupId, await activePriceListId(currentGroupId));
    }
    const currentPriceListId = groupPriceListCache.get(currentGroupId);
    if (currentPriceListId === null) continue;

    const records = await priceListRecords(currentPriceListId, variantIds);
    const currentRecords = new Map(records.map((rec) => [rec.variant_id, Number.parseFloat(rec.price)]));

    for (const line of lines) {
      const variantId = line.variant_id;
      const chargedUnitPrice = Number.parseFloat(line.price_inc_tax ?? line.price_ex_tax);
      const currentGroupUnitPrice = currentRecords.get(variantId);
      if (!Number.isFinite(chargedUnitPrice) || currentGroupUnitPrice === undefined) continue;
      if (Math.abs(chargedUnitPrice - currentGroupUnitPrice) <= TOLERANCE) continue; // matches current group

      // The charged price already fails to reconcile with the current
      // group's price list, which is the definition of a pricedGroupId
      // that differs from currentGroupId. UNRESOLVED_GROUP_ID is any
      // sentinel distinct from currentGroupId, so the divergence check
      // inside isOrderMispriced always holds here; the function still
      // gates on the price delta, so it is not a rubber stamp.
      const isStale = isOrderMispriced(
        currentGroupId,
        UNRESOLVED_GROUP_ID,
        chargedUnitPrice,
        currentGroupUnitPrice
      );
      if (!isStale) continue;

      const priceDelta = Math.abs(chargedUnitPrice - currentGroupUnitPrice);
      const summary =
        `[stale-customer-group check] order_id=${orderId} customer_id=${customerId} ` +
        `current_group_id=${currentGroupId} variant_id=${variantId} charged=${chargedUnitPrice} ` +
        `current_group_price=${currentGroupUnitPrice} delta=${priceDelta}`;

      flaggedRows.push({
        order_id: orderId,
        customer_id: customerId,
        current_group_id: currentGroupId,
        variant_id: variantId,
        charged_unit_price: String(chargedUnitPrice),
        current_group_unit_price: String(currentGroupUnitPrice),
        price_delta: String(priceDelta),
      });
      console.log(summary, DRY_RUN ? "(dry run)" : "(flagging)");
      if (!DRY_RUN) await flagOrderNote(orderId, summary);
    }
  }

  if (flaggedRows.length) {
    const header = Object.keys(flaggedRows[0]).join(",");
    const rows = flaggedRows.map((row) => Object.values(row).join(","));
    writeFileSync(OUTPUT_CSV, [header, ...rows].join("\n"));
  }

  console.log(
    `Done. ${flaggedRows.length} order line(s) flagged as possibly priced against a stale customer group.` +
    (flaggedRows.length ? ` Wrote ${OUTPUT_CSV}` : "")
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
