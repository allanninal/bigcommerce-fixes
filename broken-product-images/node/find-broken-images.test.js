import { test } from "node:test";
import assert from "node:assert/strict";
import { decideImageAction } from "./find-broken-images.js";

const image = (over = {}) => ({
  id: 1,
  image_url: "https://cdn.example.com/a.jpg",
  url_standard: "https://cdn.example.com/a.jpg",
  is_thumbnail: false,
  sort_order: 0,
  ...over,
});

test("ok when status is 2xx", () => {
  const img = image();
  const status = { [img.url_standard]: 200 };
  assert.equal(decideImageAction(img, status, [img]), "ok");
});

test("flag only when url missing", () => {
  const img = image({ url_standard: null, image_url: null });
  assert.equal(decideImageAction(img, {}, [img]), "flag_only");
});

test("flag only when url malformed", () => {
  const img = image({ url_standard: "not-a-url" });
  const status = { "not-a-url": 404 };
  assert.equal(decideImageAction(img, status, [img]), "flag_only");
});

test("clear reference when 404 and not last image", () => {
  const img = image({ id: 1 });
  const sibling = image({ id: 2, url_standard: "https://cdn.example.com/b.jpg" });
  const status = { [img.url_standard]: 404, [sibling.url_standard]: 200 };
  assert.equal(decideImageAction(img, status, [img, sibling]), "clear_reference");
});

test("flag only when 404 and only image on product", () => {
  const img = image({ id: 1 });
  const status = { [img.url_standard]: 404 };
  assert.equal(decideImageAction(img, status, [img]), "flag_only");
});

test("promote thumbnail when broken thumbnail has good sibling", () => {
  const img = image({ id: 1, is_thumbnail: true });
  const sibling = image({ id: 2, url_standard: "https://cdn.example.com/b.jpg", sort_order: 1 });
  const status = { [img.url_standard]: 403, [sibling.url_standard]: 200 };
  assert.equal(decideImageAction(img, status, [img, sibling]), "promote_thumbnail");
});

test("clear reference when broken thumbnail has no good sibling", () => {
  const img = image({ id: 1, is_thumbnail: true });
  const sibling = image({ id: 2, url_standard: "https://cdn.example.com/b.jpg", sort_order: 1 });
  const status = { [img.url_standard]: 404, [sibling.url_standard]: 404 };
  assert.equal(decideImageAction(img, status, [img, sibling]), "clear_reference");
});

test("flag only when status is unreachable but not 403 or 404", () => {
  const img = image();
  const status = { [img.url_standard]: 500 };
  assert.equal(decideImageAction(img, status, [img]), "flag_only");
});

test("clear reference falls back to image_url when url_standard absent", () => {
  const img = { id: 1, image_url: "https://cdn.example.com/only.jpg", is_thumbnail: false, sort_order: 0 };
  const sibling = image({ id: 2, url_standard: "https://cdn.example.com/b.jpg" });
  const status = { "https://cdn.example.com/only.jpg": 404, [sibling.url_standard]: 200 };
  assert.equal(decideImageAction(img, status, [img, sibling]), "clear_reference");
});
