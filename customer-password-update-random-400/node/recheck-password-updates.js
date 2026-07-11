/**
 * Tell a genuine BigCommerce password-update failure apart from a false 400.
 *
 * PUT /v3/customers is a batch array endpoint, capped at 3 concurrent requests,
 * that validates authentication.new_password against the store's password
 * complexity and history rules server side without exposing those rules
 * through the same response. A 400 for one array element can mean the
 * password genuinely failed a hidden rule, or it can mean the request
 * collided with the concurrency ceiling, or it can be a stale error on a
 * retry after the password was already written. The HTTP status code alone
 * cannot tell these apart, because the response body carries the
 * authoritative per item outcome, and the customer's own date_modified
 * timestamp is closer to ground truth than any status code.
 *
 * This script never auto-resubmits a raw password on a bare 400. It
 * re-checks every customer whose PUT returned non-2xx by diffing
 * date_modified, and by calling validate-credentials when that diff is not
 * conclusive, and only queues a corrective retry for a confirmed still-failed
 * write in a transient status class. A persistent complexity or history
 * failure is reported to a human, not retried.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/customer-password-update-random-400/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MAX_CONCURRENT_REQUESTS = 3;
const MAX_BATCH_SIZE = 10;
const TRANSIENT_STATUSES = new Set([429]);

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

function looksLikeConcurrencyError(responseBody) {
  const title = String(responseBody?.title || "").toLowerCase();
  if (title.includes("concurrent") || title.includes("rate") || title.includes("too many")) {
    return true;
  }
  for (const error of responseBody?.errors || []) {
    const text = String(error).toLowerCase();
    if (text.includes("concurrent") || text.includes("rate")) return true;
  }
  return false;
}

/**
 * Pure decision. No network, no side effects.
 *
 * If postDateModified advanced past preDateModified, the write happened,
 * regardless of httpStatus or the response body. Otherwise a transient
 * status class (429, a 500-range error, or a per-item error object naming a
 * rate or concurrency problem) gets a bounded retry. Everything else,
 * typically a persistent complexity or history validation failure, needs a
 * human, never an automatic resend of the raw password.
 */
export function decidePasswordUpdateOutcome(
  preDateModified,
  postDateModified,
  httpStatus,
  responseBody,
  customerId,
  retryCount = 0
) {
  if (postDateModified && postDateModified !== preDateModified) {
    return "confirmed_success";
  }

  const isServerError = httpStatus >= 500 && httpStatus < 600;
  const isRateOrConcurrency =
    TRANSIENT_STATUSES.has(httpStatus) || looksLikeConcurrencyError(responseBody);

  if ((isServerError || isRateOrConcurrency) && retryCount < MAX_RETRIES) {
    return "needs_retry";
  }

  return "needs_human_review";
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}, res.headers];
}

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}, res.headers];
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}, res.headers];
}

async function getCustomerDateModified(customerId) {
  const [, body] = await bcGet("/customers", { "id:in": customerId });
  const data = body.data || [];
  return data.length ? data[0].date_modified : null;
}

async function updatePassword(customerId, newPassword) {
  const body = [{
    id: customerId,
    authentication: { new_password: newPassword, force_password_reset: false },
  }];
  return bcPut("/customers", body);
}

async function validateCredentials(email, password) {
  const [status] = await bcPost("/customers/validate-credentials", { email, password });
  return status === 200;
}

/**
 * pendingUpdates: array of { id, email, newPassword, preDateModified,
 * httpStatus, responseBody, retryCount } captured from the original PUT call.
 *
 * Confirms each one via date_modified, falling back to validate-credentials,
 * then only queues a bounded retry for confirmed transient failures. Returns
 * a summary object for logging.
 */
export async function recheckAndRepair(pendingUpdates) {
  let confirmed = 0;
  let retried = 0;
  let flagged = 0;
  let inFlight = 0;

  for (const record of pendingUpdates) {
    if (inFlight >= MAX_CONCURRENT_REQUESTS) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight = 0;
    }

    const customerId = record.id;
    const postDateModified = await getCustomerDateModified(customerId);
    inFlight += 1;

    const outcome = decidePasswordUpdateOutcome(
      record.preDateModified,
      postDateModified,
      record.httpStatus,
      record.responseBody,
      customerId,
      record.retryCount || 0
    );

    if (outcome === "confirmed_success") {
      console.log(`customer_id=${customerId} confirmed_success (date_modified advanced)`);
      confirmed += 1;
      continue;
    }

    if (outcome === "needs_retry") {
      if (await validateCredentials(record.email, record.newPassword)) {
        console.log(`customer_id=${customerId} confirmed_success via validate-credentials, no resend`);
        confirmed += 1;
        continue;
      }

      console.warn(
        `customer_id=${customerId} needs_retry (status=${record.httpStatus}), ` +
        `${DRY_RUN ? "dry run, not resending" : "resending"}`
      );
      if (!DRY_RUN) {
        for (let batchStart = 0; batchStart < 1; batchStart += MAX_BATCH_SIZE) {
          await updatePassword(customerId, record.newPassword);
        }
      }
      retried += 1;
      continue;
    }

    console.error(`customer_id=${customerId} needs_human_review (status=${record.httpStatus}) email=${record.email}`);
    flagged += 1;
  }

  console.log(`Done. ${confirmed} confirmed, ${retried} retried, ${flagged} flagged for human review.`);
  return { confirmed, retried, flagged };
}

export async function run() {
  // In production this list comes from your job's own record of which PUT
  // calls returned non-2xx, captured at call time alongside preDateModified.
  const pendingUpdates = [];
  await recheckAndRepair(pendingUpdates);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
