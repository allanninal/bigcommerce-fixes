# Create customer for an existing email errors without returning the existing id

BigCommerce enforces email uniqueness for customer records at the database layer. When `POST /v3/customers` is called with an email that already belongs to a customer, the API rejects the whole batch atomically with a 422 validation error ("The email address ... is already in use by a customer."), but the error payload only has the validation message and field, never the conflicting customer's id. Because the batch is submitted as an array, the response also does not say which submitted email collided. This script catches that 422, classifies it with a pure decision function, and resolves the real id for each candidate email with `GET /v3/customers?email:in={email}`. This is not a data repair scenario, there is no bad state to fix, it is a flag and resolve workflow. Only if `DRY_RUN` is false and the caller explicitly wants an upsert does it `PUT` the existing record instead of leaving it alone.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/create-customer-existing-email-no-id-returned/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"

python create-customer-existing-email-no-id-returned/python/resolve_duplicate_customer.py
node   create-customer-existing-email-no-id-returned/node/resolve-duplicate-customer.js
```

`resolve_duplicate_customer_action` (`resolveDuplicateCustomerAction` in Node) is a pure function that takes only the parsed JSON body of a failed `POST /v3/customers` response and the list of emails submitted in that batch, so it is fully testable without a network call. It returns `{"is_duplicate_email_error": bool, "candidate_emails": [...], "next_action": "lookup_by_email" | "raise"}`. The actual `GET /v3/customers?email:in=` lookup happens outside this function, once per candidate email. Start with `DRY_RUN=true` to only resolve and log ids, never write.

## Test

```bash
pytest create-customer-existing-email-no-id-returned/python
node --test create-customer-existing-email-no-id-returned/node
```
