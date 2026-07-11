/**
 * Resolve the real customer_id when POST /v3/customers rejects an existing email.
 *
 * BigCommerce enforces email uniqueness for customer records at the database
 * layer. When POST /v3/customers is called with an email that already belongs
 * to a customer, the API rejects the whole batch atomically with a 422
 * validation error ("The email address ... is already in use by a
 * customer."), but the error payload only has the validation message and
 * field, never the conflicting customer's id. Because the batch is submitted
 * as an array, the response also does not say which submitted email
 * collided. This script catches that 422, classifies it with a pure decision
 * function, and resolves the real id for each candidate email with
 * GET /v3/customers?email:in={email}. This is not a data repair scenario,
 * there is no bad state to fix, it is a flag and resolve workflow. Only if
 * DRY_RUN is false and the caller explicitly wants an upsert does it PUT the
 * existing record instead of leaving it alone.
 *
 * Guide: https://www.allanninal.dev/bigcommerce/create-customer-existing-email-no-id-returned/
 */
import { pathToFileURL } from "node:url";

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH || "example_hash";
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN || "bc_dummy";
const API_BASE = `https://api.bigcommerce.com/stores/${STORE_HASH}/v3`;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ALREADY_IN_USE_RE = /already in use/i;

const HEADERS = {
  "X-Auth-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Pure decision. No network, no side effects.
 *
 * Given the parsed JSON body of a failed POST /v3/customers response (with
 * .status, .title, .errors) and the list of emails submitted in that batch,
 * decide whether this is an "email already in use" collision (regex match on
 * title/errors messages) and which submitted email(s) are lookup candidates,
 * since the response itself never names them. Returns
 * { isDuplicateEmailError, candidateEmails, nextAction }.
 */
export function resolveDuplicateCustomerAction(createResponse, submittedEmails) {
  const status = createResponse.status;
  const title = createResponse.title || "";
  const errors = createResponse.errors || {};

  const messages = [title];
  if (Array.isArray(errors)) {
    for (const e of errors) {
      messages.push(typeof e === "object" && e !== null ? String(e.message || "") : String(e));
    }
  } else if (errors && typeof errors === "object") {
    for (const v of Object.values(errors)) messages.push(String(v));
  }

  const isDuplicate = status === 422 && messages.some((m) => m && ALREADY_IN_USE_RE.test(m));

  if (isDuplicate) {
    return {
      isDuplicateEmailError: true,
      candidateEmails: [...submittedEmails],
      nextAction: "lookup_by_email",
    };
  }
  return {
    isDuplicateEmailError: false,
    candidateEmails: [],
    nextAction: "raise",
  };
}

async function bcPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : {}];
}

async function bcGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : { data: [] };
}

async function bcPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigCommerce ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function createCustomers(customerPayloads) {
  const [status, body] = await bcPost("/customers", customerPayloads);
  const submittedEmails = customerPayloads.filter((c) => c.email).map((c) => c.email);
  return { status, body, submittedEmails };
}

async function resolveCustomerIdByEmail(email) {
  const body = await bcGet("/customers", { "email:in": email, include: "storecredit,attributes" });
  const data = body.data || [];
  return data.length ? data[0].id : null;
}

async function upsertCustomer(customerId, fields) {
  const payload = { ...fields, id: customerId };
  return bcPut("/customers", [payload]);
}

export async function run(customerPayloads, upsertFields = null) {
  const { status, body, submittedEmails } = await createCustomers(customerPayloads);

  if (status === 200 || status === 201) {
    console.log(`Created ${(body.data || []).length} customer(s).`);
    return;
  }

  const createResponse = { status, title: body.title, errors: body.errors };
  const decision = resolveDuplicateCustomerAction(createResponse, submittedEmails);

  if (!decision.isDuplicateEmailError) {
    throw new Error(`BigCommerce create failed: status=${status} body=${JSON.stringify(body)}`);
  }

  for (const email of decision.candidateEmails) {
    const resolvedId = await resolveCustomerIdByEmail(email);
    if (resolvedId === null) {
      console.warn(`email=${email} flagged as duplicate but no matching customer found.`);
      continue;
    }

    console.log(`email=${email} resolved_customer_id=${resolvedId}`);

    if (!DRY_RUN && upsertFields !== null) {
      await upsertCustomer(resolvedId, upsertFields);
      console.log(`email=${email} customer_id=${resolvedId} updated via PUT /v3/customers`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run([{ email: "shopper@example.com", first_name: "Jamie", last_name: "Rivera" }]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
