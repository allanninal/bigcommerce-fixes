import { test } from "node:test";
import assert from "node:assert/strict";
import { isOrderMissed } from "./backfill-missed-webhooks.js";

const WINDOW_START = "2026-07-05T00:00:00+00:00";
const WINDOW_END = "2026-07-07T00:00:00+00:00";

const remote = (over = {}) => ({ statusId: 11, dateModified: "2026-07-06T00:00:00+00:00", ...over });
const local = (over = {}) => ({ statusId: 11, dateModified: "2026-07-06T00:00:00+00:00", ...over });

test("never seen order is missed", () => {
  assert.equal(isOrderMissed(null, remote(), WINDOW_START, WINDOW_END), true);
});

test("status changed is missed", () => {
  const stale = local({ statusId: 11 });
  const fresh = remote({ statusId: 2 });
  assert.equal(isOrderMissed(stale, fresh, WINDOW_START, WINDOW_END), true);
});

test("local older than remote is missed", () => {
  const stale = local({ dateModified: "2026-07-05T12:00:00+00:00" });
  const fresh = remote({ dateModified: "2026-07-06T12:00:00+00:00" });
  assert.equal(isOrderMissed(stale, fresh, WINDOW_START, WINDOW_END), true);
});

test("matching local state is not missed", () => {
  const same = local({ statusId: 2, dateModified: "2026-07-06T00:00:00+00:00" });
  const fresh = remote({ statusId: 2, dateModified: "2026-07-06T00:00:00+00:00" });
  assert.equal(isOrderMissed(same, fresh, WINDOW_START, WINDOW_END), false);
});

test("outside window is not missed", () => {
  const outside = remote({ dateModified: "2026-07-08T00:00:00+00:00" });
  assert.equal(isOrderMissed(null, outside, WINDOW_START, WINDOW_END), false);
});

test("before window is not missed", () => {
  const before = remote({ dateModified: "2026-07-04T00:00:00+00:00" });
  assert.equal(isOrderMissed(null, before, WINDOW_START, WINDOW_END), false);
});

test("local newer than remote is not missed", () => {
  const newerLocal = local({ statusId: 2, dateModified: "2026-07-06T12:00:00+00:00" });
  const olderRemote = remote({ statusId: 2, dateModified: "2026-07-06T00:00:00+00:00" });
  assert.equal(isOrderMissed(newerLocal, olderRemote, WINDOW_START, WINDOW_END), false);
});

test("boundary timestamps are inclusive", () => {
  const atStart = remote({ dateModified: WINDOW_START });
  const atEnd = remote({ dateModified: WINDOW_END });
  assert.equal(isOrderMissed(null, atStart, WINDOW_START, WINDOW_END), true);
  assert.equal(isOrderMissed(null, atEnd, WINDOW_START, WINDOW_END), true);
});
