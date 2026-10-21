import assert from "node:assert/strict";
import { test } from "node:test";
import { getPublishedPostCounts } from "../src/lib/post-counts.mjs";

const categories = [
  { name: "Art" },
  { name: "Exhibition" },
  { name: "Creative" },
];
const post = (category, draft, extra = {}) => ({ data: { category, draft, ...extra } });

test("counts only explicitly published posts, regardless of development-only draft records", () => {
  const published = [
    post("Art", false),
    post("Exhibition", false),
    post("Creative", false),
  ];
  const developmentCollection = [
    ...published,
    post("Art", true, { workflowStatus: "Review" }),
    post("Creative", true, { workflowStatus: "Approved" }),
    post("Exhibition", true, { workflowStatus: "Draft" }),
  ];
  const productionCollection = published;

  assert.deepEqual(
    getPublishedPostCounts(developmentCollection, categories),
    getPublishedPostCounts(productionCollection, categories),
  );
  assert.deepEqual(getPublishedPostCounts(developmentCollection, categories), {
    total: 3,
    categories: { Art: 1, Exhibition: 1, Creative: 1 },
  });
});

test("category counts add up to the public total", () => {
  const counts = getPublishedPostCounts([
    post("Art", false),
    post("Art", false),
    post("Exhibition", false),
    post("Creative", false),
    post("Creative", false),
    post("Creative", true, { workflowStatus: "Approved" }),
  ], categories);

  assert.equal(counts.total, 5);
  assert.equal(Object.values(counts.categories).reduce((sum, count) => sum + count, 0), counts.total);
  assert.deepEqual(counts.categories, { Art: 2, Exhibition: 1, Creative: 2 });
});

test("published counts increase automatically when a published post is added", () => {
  const posts = [post("Art", false)];
  const before = getPublishedPostCounts(posts, categories);
  posts.push(post("Exhibition", false));
  const after = getPublishedPostCounts(posts, categories);

  assert.equal(before.total, 1);
  assert.equal(after.total, 2);
  assert.equal(after.categories.Exhibition, 1);
});

test("empty collections produce zero counts without errors", () => {
  assert.deepEqual(getPublishedPostCounts([], categories), {
    total: 0,
    categories: { Art: 0, Exhibition: 0, Creative: 0 },
  });
});

test("an unconfigured category fails instead of making totals silently disagree", () => {
  assert.throws(
    () => getPublishedPostCounts([post("Unknown", false)], categories),
    /unknown category/,
  );
});
