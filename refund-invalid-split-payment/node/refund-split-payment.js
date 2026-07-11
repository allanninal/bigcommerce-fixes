/**
 * Refund a BigCommerce order paid with more than one tender without tripping
 * "the requested refund had invalid split payment."
 *
 * An order paid with more than one tender, part gift card and part credit card,
 * or store credit plus PayPal, settles as separate transactions against separate
 * payment providers, each capped at what that provider actually captured. The V3
 * refund endpoint, POST /v3/orders/{order_id}/payment_actions/refunds, requires
 * the payments[].provider_id and payments[].amount in the request to exactly
 * match an entry the gateway already approved in a prior refund quote from
 * POST /v3/orders/{order_id}/payment_actions/refund_quotes. It will not
 * automatically split a lump sum refund across tenders. This script always
 * requests the quote first, builds the payments array from the quote's own
 * refund_methods, and only then posts the refund. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/refund-invalid-split-payment/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "example_token";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Takes refundQuote.refund_methods (a list of {provider_id, amount} entries as
 * returned by POST .../refund_quotes) and the decimal-string requestedTotal.
 * Returns a list of {provider_id, amount} entries such that:
 *
 *   (a) no entry's amount exceeds that method's quoted max,
 *   (b) entries are ordered by provider_id for determinism,
 *   (c) entries' amounts sum exactly to requestedTotal (throws if
 *       requestedTotal exceeds the sum of all refund_methods amounts, i.e.
 *       an over-refund attempt), and
 *   (d) throws if requestedTotal is zero/negative or refund_methods is empty.
 *
 * Multi vs single tender is simply refund_methods.length > 1, handled
 * naturally by this same loop; no special casing needed.
 */
export function buildSplitRefundPayload(refundQuote, requestedTotal) {
  const methods = [...((refundQuote && refundQuote.refund_methods) || [])].sort((a, b) =>
    a.provider_id < b.provider_id ? -1 : a.provider_id > b.provider_id ? 1 : 0
  );
  if (methods.length === 0) {
    throw new Error("refund_quote has no refund_methods to split across");
  }

  const total = Number(requestedTotal);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("requested_total must be greater than zero");
  }

  const availableTotal = methods.reduce((sum, m) => sum + Number(m.amount), 0);
  if (total > availableTotal + 1e-9) {
    throw new Error(`requested_total ${total} exceeds available refund amount ${availableTotal}`);
  }

  let remaining = total;
  const payload = [];
  for (const method of methods) {
    if (remaining <= 0) break;
    const maxAmount = Number(method.amount);
    const take = Math.min(maxAmount, remaining);
    payload.push({ provider_id: method.provider_id, amount: take.toFixed(2) });
    remaining = Math.round((remaining - take) * 100) / 100;
  }

  return payload;
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

async function requestRefundQuote(orderId, quotePayload) {
  return bcPost(`/orders/${orderId}/payment_actions/refund_quotes`, quotePayload);
}

async function postRefund(orderId, payments) {
  return bcPost(`/orders/${orderId}/payment_actions/refunds`, { payments });
}

/**
 * Quote, split, and (if not a dry run) post the refund for one order.
 *
 * One order, one refund call at a time: BigCommerce does not support
 * concurrent refunds on the same order, so this should not be called
 * concurrently for the same orderId.
 */
export async function refundOrder(orderId, quotePayload, requestedTotal) {
  const quoteResponse = await requestRefundQuote(orderId, quotePayload);
  const refundQuote = quoteResponse.data || quoteResponse;

  const payments = buildSplitRefundPayload(refundQuote, requestedTotal);

  console.log(
    `order_id=${orderId} requested_total=${requestedTotal} split=${JSON.stringify(payments)} ` +
    `(${DRY_RUN ? "dry run" : "posting"})`
  );

  if (DRY_RUN) {
    return { orderId, payments, posted: false };
  }

  const result = await postRefund(orderId, payments);
  return { orderId, payments, posted: true, result };
}

export async function run() {
  const orderId = process.env.ORDER_ID || "0";
  const requestedTotal = process.env.REQUESTED_TOTAL || "0.00";
  const outcome = await refundOrder(orderId, { reason: "Customer request" }, requestedTotal);
  console.log(`Done. order_id=${outcome.orderId} posted=${outcome.posted}`);
  return outcome;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
