/**
 * Count only explicitly published entries from the Astro blog collection.
 * Development-only drafts and workflow statuses never affect these counts.
 * @param {readonly {data: {draft?: unknown, category?: string}}[]} posts
 * @param {readonly {name: string}[]} categories
 * @returns {{total: number, categories: Record<string, number>}}
 */
export function getPublishedPostCounts(posts, categories) {
  const categoryCounts = Object.fromEntries(categories.map(({ name }) => [name, 0]));

  for (const post of posts) {
    if (post?.data?.draft !== false) continue;
    const category = post.data.category;
    if (!Object.hasOwn(categoryCounts, category)) {
      throw new Error("Published article has an unknown category: " + String(category));
    }
    categoryCounts[category] += 1;
  }

  const total = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
  return { total, categories: categoryCounts };
}
