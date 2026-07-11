import { test } from "node:test";
import assert from "node:assert/strict";
import { diffMissingImages, nextSortOrder } from "./requeue-missing-images.js";

const persisted = (imageUrl, sortOrder = 0, id = 1) => ({
  id, image_url: imageUrl, is_thumbnail: false, sort_order: sortOrder,
});

test("no missing images when everything persisted", () => {
  const source = ["https://cdn.example.com/imports/a.jpg", "https://cdn.example.com/imports/b.jpg"];
  const persistedImages = [
    persisted("https://cdn.bigcommerce.com/store/products/1/a.jpg", 0),
    persisted("https://cdn.bigcommerce.com/store/products/1/b.jpg", 1),
  ];
  assert.deepEqual(diffMissingImages(source, persistedImages), []);
});

test("only first image persisted reports the rest missing", () => {
  const source = [
    "https://cdn.example.com/imports/a.jpg",
    "https://cdn.example.com/imports/b.jpg",
    "https://cdn.example.com/imports/c.jpg",
  ];
  const persistedImages = [persisted("https://cdn.bigcommerce.com/store/products/1/a.jpg", 0)];
  assert.deepEqual(diffMissingImages(source, persistedImages), [
    "https://cdn.example.com/imports/b.jpg",
    "https://cdn.example.com/imports/c.jpg",
  ]);
});

test("matching is by normalized filename not exact url", () => {
  const source = ["https://cdn.example.com/imports/A.JPG%20"];
  const persistedImages = [persisted("https://cdn.bigcommerce.com/store/products/1/a.jpg", 0)];
  assert.deepEqual(diffMissingImages(source, persistedImages), []);
});

test("no persisted images means everything is missing", () => {
  const source = ["https://cdn.example.com/imports/a.jpg", "https://cdn.example.com/imports/b.jpg"];
  assert.deepEqual(diffMissingImages(source, []), source);
});

test("preserves source order for requeuing", () => {
  const source = ["https://cdn.example.com/imports/z.jpg", "https://cdn.example.com/imports/a.jpg"];
  assert.deepEqual(diffMissingImages(source, []), source);
});

test("next sort order continues after highest existing", () => {
  const persistedImages = [persisted("a.jpg", 0), persisted("b.jpg", 3)];
  assert.equal(nextSortOrder(persistedImages), 4);
});

test("next sort order starts at zero when no images persisted", () => {
  assert.equal(nextSortOrder([]), 0);
});
