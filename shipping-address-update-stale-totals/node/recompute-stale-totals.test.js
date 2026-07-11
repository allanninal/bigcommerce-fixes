import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecompute, hashAddress } from "./recompute-stale-totals.js";

const address = ({ street_1 = "123 Main St", city = "Austin", state = "TX", zip = "78701", country_iso2 = "US" } = {}) => (
  { street_1, city, state, zip, country_iso2 }
);

test("skip_locked_status even if address changed", () => {
  const order = { status_id: 2 };
  const result = decideRecompute(order, address({ city: "Dallas" }), hashAddress(address()));
  assert.equal(result.action, "skip_locked_status");
  assert.equal(result.stale_totals, false);
});

test("recompute when address changed and totals unchanged", () => {
  const order = { status_id: 9, _totalsUnchangedSinceSnapshot: true };
  const result = decideRecompute(order, address({ city: "Dallas" }), hashAddress(address()));
  assert.equal(result.address_changed, true);
  assert.equal(result.stale_totals, true);
  assert.equal(result.action, "recompute");
});

test("flag_only when address unchanged", () => {
  const sameAddress = address();
  const order = { status_id: 11, _totalsUnchangedSinceSnapshot: true };
  const result = decideRecompute(order, sameAddress, hashAddress(sameAddress));
  assert.equal(result.address_changed, false);
  assert.equal(result.stale_totals, false);
  assert.equal(result.action, "flag_only");
});

test("flag_only when address changed but totals already moved", () => {
  const order = { status_id: 7, _totalsUnchangedSinceSnapshot: false };
  const result = decideRecompute(order, address({ city: "Dallas" }), hashAddress(address()));
  assert.equal(result.address_changed, true);
  assert.equal(result.stale_totals, false);
  assert.equal(result.action, "flag_only");
});

test("hashAddress is case and whitespace insensitive", () => {
  const a = address({ city: "Austin" });
  const b = address({ city: " austin " });
  assert.equal(hashAddress(a), hashAddress(b));
});

test("hashAddress changes when zip changes", () => {
  assert.notEqual(hashAddress(address({ zip: "78701" })), hashAddress(address({ zip: "90001" })));
});

test("first-seen order with no cached hash counts as changed", () => {
  const order = { status_id: 1, _totalsUnchangedSinceSnapshot: true };
  const result = decideRecompute(order, address(), null);
  assert.equal(result.address_changed, true);
  assert.equal(result.action, "recompute");
});
