/**
 * Find BigCommerce orders that look like staff test checkouts counted as revenue.
 *
 * BigCommerce order objects, in both /v2/orders and V3, have no is_test flag. Every
 * store ships with a Test Payment Gateway enabled by default so staff can validate
 * tax, shipping, and promotion configuration by placing real checkouts, and merchants
 * often leave real gateways in sandbox mode during setup too. Those checkouts create
 * fully formed orders with normal, revenue-counted status_id values, and Store Overview
 * and Sales reports simply aggregate by status_id, so the test order counts as revenue.
 *
 * This job lists revenue-counted orders in a reporting window, pulls each order's
 * transactions, and classifies it with a pure function against four signals: a test
 * transaction flag, a Test Payment Gateway name, a test-looking billing email, and a
 * nominal guest checkout total. Anything that classifies as a test order gets a
 * non-destructive marker appended to the internal staff_notes field. Nothing is ever
 * cancelled or deleted automatically. Guarded by DRY_RUN. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/test-orders-counted-in-sales-reports/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "store_dummy";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "token_dummy";
const BASE_URL = `https://api.bigcommerce.com/stores/${STORE_HASH}/`;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const NON_REVENUE_STATUS_IDS = new Set([0, 5, 6]); // Incomplete, Cancelled, Declined

const DEFAULT_TEST_EMAIL_PATTERNS = [/test@/i, /@example\.com$/i, /^qa[-_.]?/i];

/**
 * Pure decision function. No network calls.
 *
 * Flags an order as a likely test order when any independent signal points to a
 * staff or QA checkout: a transaction marked test true, a transaction whose gateway
 * name matches Test Payment Gateway, a billing email matching a known test pattern,
 * or a guest checkout with a nominal total of one dollar or less. A non-revenue
 * status_id (Incomplete, Cancelled, Declined) is recorded as a reason for visibility
 * but never on its own marks the order as a test, since reports already exclude it.
 */
export function classifyTestOrder(order, transactions, testEmailPatterns = DEFAULT_TEST_EMAIL_PATTERNS) {
  const reasons = [];

  if (transactions.some((t) => t.test === true)) reasons.push("test_gateway_transaction");

  if (transactions.some((t) => /test payment gateway/i.test(t.gateway || ""))) {
    reasons.push("test_gateway_name");
  }

  const email = order.billing_address?.email || "";
  if (testEmailPatterns.some((rx) => rx.test(email))) reasons.push("test_email_pattern");

  if (order.customer_id === 0 && parseFloat(order.total_inc_tax || 0) <= 1.00) {
    reasons.push("nominal_staff_test_amount");
  }

  if (NON_REVENUE_STATUS_IDS.has(order.status_id)) reasons.push("non_revenue_status");

  const isTest = reasons.length > 0 && reasons.some((r) => r !== "non_revenue_status");
  return { isTest, reasons };
}

function headers() {
  return {
    "X-Auth-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function minDateCreated() {
  const d = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return d.toUTCString().replace("GMT", "+0000");
}

async function* listRevenueOrders() {
  const limit = 50;
  let page = 1;
  const since = minDateCreated();
  while (true) {
    const url = new URL(BASE_URL + "v2/orders");
    url.searchParams.set("min_date_created", since);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));

    const res = await fetch(url, { headers: headers() });
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
    const orders = await res.json();
    if (!orders || orders.length === 0) return;
    for (const order of orders) {
      if (!NON_REVENUE_STATUS_IDS.has(order.status_id)) yield order;
    }
    if (orders.length < limit) return;
    page++;
  }
}

async function getTransactions(orderId) {
  const res = await fetch(BASE_URL + `v2/orders/${orderId}/transactions`, { headers: headers() });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

async function flagAsTestOrder(order, reasons) {
  const marker = `[TEST ORDER: ${reasons.join(", ")}] `;
  const existingNotes = order.staff_notes || "";
  if (existingNotes.startsWith("[TEST ORDER:")) return null; // already flagged
  const res = await fetch(BASE_URL + `v2/orders/${order.id}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ staff_notes: marker + existingNotes }),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  return res.json();
}

export async function run() {
  let flagged = 0;

  for await (const order of listRevenueOrders()) {
    const orderId = order.id;
    const transactions = await getTransactions(orderId);
    const result = classifyTestOrder(order, transactions);

    if (!result.isTest) continue;

    const existingNotes = order.staff_notes || "";
    if (existingNotes.startsWith("[TEST ORDER:")) continue;

    console.log(
      `Order ${orderId} looks like a test order (${result.reasons.join(", ")}). ${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flagAsTestOrder(order, result.reasons);
    flagged++;
  }

  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
