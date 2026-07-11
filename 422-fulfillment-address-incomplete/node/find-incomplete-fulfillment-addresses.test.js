import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingAddressFields } from "./find-incomplete-fulfillment-addresses.js";

const completeAddress = (overrides = {}) => ({
  first_name: "Jane",
  last_name: "Doe",
  address1: "123 Main St",
  city: "Austin",
  state_or_province_code: "TX",
  postal_code: "78701",
  country_code: "US",
  phone: "5125550100",
  ...overrides,
});

test("no missing fields on a fully complete address", () => {
  assert.deepEqual(findMissingAddressFields(completeAddress()), []);
});

test("reports missing state_or_province_code", () => {
  const address = completeAddress({ state_or_province_code: null });
  assert.deepEqual(findMissingAddressFields(address), ["state_or_province_code"]);
});

test("reports missing postal_code when empty string", () => {
  const address = completeAddress({ postal_code: "" });
  assert.deepEqual(findMissingAddressFields(address), ["postal_code"]);
});

test("reports missing phone when key absent entirely", () => {
  const address = completeAddress();
  delete address.phone;
  assert.deepEqual(findMissingAddressFields(address), ["phone"]);
});

test("accepts zip, street_1, and country_iso2 aliases", () => {
  const address = {
    first_name: "Jane",
    last_name: "Doe",
    street_1: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country_iso2: "US",
    phone: "5125550100",
  };
  assert.deepEqual(findMissingAddressFields(address), []);
});

test("reports invalid country_code that is not two letters", () => {
  const address = completeAddress({ country_code: "USA" });
  assert.deepEqual(findMissingAddressFields(address), ["country_code"]);
});

test("reports multiple missing fields in order", () => {
  const address = completeAddress({ postal_code: "", phone: "" });
  assert.deepEqual(findMissingAddressFields(address), ["postal_code", "phone"]);
});

test("empty address reports every required field", () => {
  assert.deepEqual(findMissingAddressFields({}), [
    "first_name", "last_name", "address1", "city",
    "state_or_province_code", "postal_code", "country_code", "phone",
  ]);
});
