import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseImageRepairStrategy } from "./repair-category-images.js";

test("missing image_url with public_url uses put_image_url", () => {
  const category = { id: 42, image_url: null };
  const source = { public_url: "https://cdn.example.com/cat-42.jpg", local_file_path: null };
  const result = chooseImageRepairStrategy(category, source);
  assert.equal(result.action, "put_image_url");
  assert.equal(result.field, "image_url");
  assert.equal(result.value, "https://cdn.example.com/cat-42.jpg");
});

test("stale image_url differing from source uses put_image_url", () => {
  const category = { id: 42, image_url: "https://cdn.example.com/old.jpg" };
  const source = { public_url: "https://cdn.example.com/new.jpg", local_file_path: null };
  const result = chooseImageRepairStrategy(category, source);
  assert.equal(result.action, "put_image_url");
  assert.equal(result.value, "https://cdn.example.com/new.jpg");
});

test("no public_url with local file uses multipart upload", () => {
  const category = { id: 42, image_url: null };
  const source = { public_url: null, local_file_path: "/tmp/cat-42.jpg" };
  const result = chooseImageRepairStrategy(category, source);
  assert.equal(result.action, "post_multipart_image");
  assert.equal(result.field, "image_file");
  assert.equal(result.endpoint, "/v3/catalog/categories/42/image");
});

test("no source at all flags for review", () => {
  const category = { id: 42, image_url: null };
  const source = { public_url: null, local_file_path: null };
  const result = chooseImageRepairStrategy(category, source);
  assert.deepEqual(result, { action: "flag", reason: "no_image_source_available" });
});

test("put_image_url is never paired with the image_file field", () => {
  const cases = [
    [{ id: 1, image_url: null }, { public_url: "https://cdn.example.com/a.jpg", local_file_path: null }],
    [{ id: 2, image_url: "https://cdn.example.com/old.jpg" }, { public_url: "https://cdn.example.com/new.jpg", local_file_path: "/tmp/a.jpg" }],
  ];
  for (const [category, source] of cases) {
    const result = chooseImageRepairStrategy(category, source);
    assert.ok(!(result.action === "put_image_url" && result.field === "image_file"));
  }
});
