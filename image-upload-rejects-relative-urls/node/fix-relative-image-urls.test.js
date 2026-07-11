import { test } from "node:test";
import assert from "node:assert/strict";
import { isFixableImageUrl } from "./fix-relative-image-urls.js";

test("root-relative path is fixable with a base url", () => {
  const result = isFixableImageUrl("/images/shoe.jpg", "https://cdn.example.com");
  assert.deepEqual(result, { status: "fixable", resolvedUrl: "https://cdn.example.com/images/shoe.jpg" });
});

test("relative path with no base needs review", () => {
  const result = isFixableImageUrl("images/shoe.jpg", null);
  assert.equal(result.status, "needs_review");
  assert.equal(result.resolvedUrl, null);
});

test("fully qualified url is already valid", () => {
  const result = isFixableImageUrl("https://cdn.example.com/shoe.jpg", null);
  assert.deepEqual(result, { status: "already_valid", resolvedUrl: "https://cdn.example.com/shoe.jpg" });
});

test("protocol-relative url is fixable only with a base scheme", () => {
  const noBase = isFixableImageUrl("//cdn.example.com/shoe.jpg", null);
  assert.equal(noBase.status, "needs_review");

  const withBase = isFixableImageUrl("//cdn.example.com/shoe.jpg", "https://cdn.example.com");
  assert.equal(withBase.status, "fixable");
  assert.equal(withBase.resolvedUrl, "https://cdn.example.com/shoe.jpg");
});

test("unsupported scheme is never fixable", () => {
  const result = isFixableImageUrl("ftp://old.example.com/shoe.jpg", "https://cdn.example.com");
  assert.deepEqual(result, { status: "unsupported_scheme", resolvedUrl: null });
});

test("bare filename with a base url is fixable", () => {
  const result = isFixableImageUrl("shoe.jpg", "https://cdn.example.com/images/");
  assert.equal(result.status, "fixable");
  assert.equal(result.resolvedUrl, "https://cdn.example.com/images/shoe.jpg");
});

test("invalid base url falls back to needs review", () => {
  const result = isFixableImageUrl("/images/shoe.jpg", "not-a-real-base");
  assert.equal(result.status, "needs_review");
  assert.equal(result.resolvedUrl, null);
});
