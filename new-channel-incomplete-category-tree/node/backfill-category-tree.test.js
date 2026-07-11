import { test } from "node:test";
import assert from "node:assert/strict";
import { diffCategoryTrees } from "./backfill-category-tree.js";

const node = (id, name, parentId = null) => ({ id, name, parent_id: parentId });

test("identical trees have no missing nodes", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1)];
  const secondary = [node(11, "Shoes"), node(12, "Boots", 11)];
  assert.deepEqual(diffCategoryTrees(primary, secondary).missing, []);
});

test("empty secondary tree reports every primary node", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1)];
  const missing = diffCategoryTrees(primary, []).missing;
  assert.deepEqual(missing.map((m) => m.path), [["Shoes"], ["Shoes", "Boots"]]);
});

test("parents are listed before their children", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1), node(3, "Winter Boots", 2)];
  const missing = diffCategoryTrees(primary, []).missing;
  const depths = missing.map((m) => m.path.length);
  assert.deepEqual(depths, [...depths].sort((a, b) => a - b));
});

test("reordered siblings still match by path", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1), node(3, "Sandals", 1)];
  const secondary = [node(21, "Shoes"), node(22, "Sandals", 21), node(23, "Boots", 21)];
  assert.deepEqual(diffCategoryTrees(primary, secondary).missing, []);
});

test("renamed parent causes children to appear missing", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1)];
  const secondary = [node(11, "Footwear"), node(12, "Boots", 11)];
  const paths = diffCategoryTrees(primary, secondary).missing.map((m) => m.path);
  assert.ok(paths.some((p) => JSON.stringify(p) === JSON.stringify(["Shoes"])));
  assert.ok(paths.some((p) => JSON.stringify(p) === JSON.stringify(["Shoes", "Boots"])));
});

test("multi-level gap reports only the missing branch", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1), node(3, "Winter Boots", 2)];
  const secondary = [node(11, "Shoes"), node(12, "Boots", 11)];
  const missing = diffCategoryTrees(primary, secondary).missing;
  assert.deepEqual(missing.map((m) => m.path), [["Shoes", "Boots", "Winter Boots"]]);
});

test("missing node parent_path is computed correctly", () => {
  const primary = [node(1, "Shoes"), node(2, "Boots", 1)];
  const missing = diffCategoryTrees(primary, []).missing;
  const boots = missing.find((m) => m.name === "Boots");
  assert.deepEqual(boots.parent_path, ["Shoes"]);
});

test("top level node has empty parent_path", () => {
  const primary = [node(1, "Shoes")];
  const missing = diffCategoryTrees(primary, []).missing;
  assert.deepEqual(missing[0].parent_path, []);
});

test("cyclic parent_id does not infinite loop", () => {
  const primary = [node(1, "A", 2), node(2, "B", 1)];
  const result = diffCategoryTrees(primary, []);
  assert.equal(result.missing.length, 2);
});
