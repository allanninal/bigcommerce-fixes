/**
 * Find BigCommerce orders where only one side of a tax override pair was set.
 *
 * The V2 Orders API (POST/PUT /v2/orders) lets integrators override computed
 * money fields, but each override is defined in tax-inclusive/exclusive pairs:
 * a line item's price_inc_tax requires price_ex_tax (and vice versa), and an
 * order's total_inc_tax requires total_ex_tax (and vice versa). If a client
 * sets only one side of a pair, BigCommerce does not reject the request or
 * auto-derive the missing value. It stores exactly what it was given, so the
 * untouched field keeps its stale or default value, often 0.00. This produces
 * an order whose totals do not reconcile against tax_total or the sum of its
 * line items. Because correcting historical tax amounts is a financial and
 * compliance decision, this job reports findings by default and only writes a
 * guarded repair for orders explicitly confirmed as not yet invoiced or shipped.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/order-total-partial-tax-field-override/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v2`;
const MIN_DATE_CREATED = process.env.MIN_DATE_CREATED || "-30 days";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIRMED_ORDER_IDS = new Set(
  (process.env.CONFIRMED_ORDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

const EPSILON = 0.01;
const REPAIRABLE_STATUS_IDS = new Set([0, 11]); // Incomplete, Awaiting Fulfillment

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function checkPair(scope, entityId, fieldA, fieldB, valueA, valueB, findings) {
  const a = toNumber(valueA);
  const b = toNumber(valueB);
  const aSet = a !== null && a !== 0;
  const bSet = b !== null && b !== 0;
  if (aSet !== bSet) {
    findings.push({
      scope,
      id: entityId,
      field_pair: [fieldA, fieldB],
      value_a: a !== null ? a : 0,
      value_b: b !== null ? b : 0,
      reason: "partial_override",
    });
  }
}

/**
 * Pure decision logic, no I/O.
 *
 * Takes an already-fetched order object (from GET /v2/orders/{id}) and its
 * line items (from GET /v2/orders/{id}/products), both with money fields as
 * strings. Returns a list of finding objects: {scope, id, field_pair,
 * value_a, value_b, reason}. Empty array means the order is internally
 * consistent.
 *
 * Logic:
 *   1. For the order and for each line item, parse the ex_tax/inc_tax pair
 *      as a number.
 *   2. If one of the pair is zero/null and the other is non-zero -> emit a
 *      partial_override finding.
 *   3. Sum line items' total_inc_tax (+shipping_cost_inc_tax
 *      +handling_cost_inc_tax -discount_amount) and compare to
 *      order.total_inc_tax; if abs(diff) > epsilon -> emit a total_mismatch
 *      finding.
 *   4. Return all findings (empty array = consistent order).
 */
export function findTaxOverrideDesync(order, lineItems, epsilon = EPSILON) {
  const findings = [];

  checkPair(
    "order", order.id, "total_ex_tax", "total_inc_tax",
    order.total_ex_tax, order.total_inc_tax, findings
  );

  for (const item of lineItems || []) {
    checkPair(
      "line_item", item.id, "price_ex_tax", "price_inc_tax",
      item.price_ex_tax, item.price_inc_tax, findings
    );
  }

  const lineSum = (lineItems || []).reduce(
    (sum, item) => sum + (toNumber(item.total_inc_tax) || 0), 0
  );
  const shipping = toNumber(order.shipping_cost_inc_tax) || 0;
  const handling = toNumber(order.handling_cost_inc_tax) || 0;
  const discount = toNumber(order.discount_amount) || 0;
  const computedTotal = lineSum + shipping + handling - discount;
  const orderTotal = toNumber(order.total_inc_tax) || 0;

  if (Math.abs(computedTotal - orderTotal) > epsilon) {
    findings.push({
      scope: "order",
      id: order.id,
      field_pair: ["computed_total_inc_tax", "total_inc_tax"],
      value_a: computedTotal,
      value_b: orderTotal,
      reason: "total_mismatch",
    });
  }

  return findings;
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
    const orders = await bcGet("/orders", {
      min_date_created: MIN_DATE_CREATED,
      page,
      limit: 250,
    });
    if (!orders.length) return;
    for (const order of orders) yield order;
    page += 1;
  }
}

async function orderLineItems(orderId) {
  return bcGet(`/orders/${orderId}/products`);
}

async function repairOrder(order, computedTotalExTax, computedTotalIncTax) {
  return bcPut(`/orders/${order.id}`, {
    total_ex_tax: String(computedTotalExTax),
    total_inc_tax: String(computedTotalIncTax),
  });
}

export async function run() {
  let ordersChecked = 0;
  let ordersWithFindings = 0;
  let totalFindings = 0;

  for await (const order of candidateOrders()) {
    ordersChecked += 1;
    const orderId = order.id;
    const lineItems = await orderLineItems(orderId);

    const findings = findTaxOverrideDesync(order, lineItems);

    if (!findings.length) continue;

    ordersWithFindings += 1;
    totalFindings += findings.length;

    for (const finding of findings) {
      console.warn(
        `scope=${finding.scope} id=${finding.id} field_pair=${finding.field_pair} ` +
        `value_a=${finding.value_a} value_b=${finding.value_b} reason=${finding.reason} order_id=${orderId}`
      );
    }

    const statusId = order.status_id;
    if (CONFIRMED_ORDER_IDS.has(orderId) && REPAIRABLE_STATUS_IDS.has(statusId)) {
      const lineSumInc = (lineItems || []).reduce((s, i) => s + (toNumber(i.total_inc_tax) || 0), 0);
      const lineSumEx = (lineItems || []).reduce((s, i) => s + (toNumber(i.total_ex_tax) || 0), 0);
      const shippingInc = toNumber(order.shipping_cost_inc_tax) || 0;
      const shippingEx = toNumber(order.shipping_cost_ex_tax) || 0;
      const handlingInc = toNumber(order.handling_cost_inc_tax) || 0;
      const handlingEx = toNumber(order.handling_cost_ex_tax) || 0;
      const discount = toNumber(order.discount_amount) || 0;

      const recomputedInc = lineSumInc + shippingInc + handlingInc - discount;
      const recomputedEx = lineSumEx + shippingEx + handlingEx - discount;

      console.log(
        `order_id=${orderId} confirmed repair candidate. recomputed_total_ex_tax=${recomputedEx} ` +
        `recomputed_total_inc_tax=${recomputedInc} (${DRY_RUN ? "dry run" : "writing"})`
      );
      if (!DRY_RUN) await repairOrder(order, recomputedEx, recomputedInc);
    }
  }

  console.log(
    `Done. ${ordersChecked} order(s) checked, ${ordersWithFindings} order(s) with findings, ${totalFindings} finding(s) total.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
