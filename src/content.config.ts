import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
  schema: ({ image }) => z.object({
    title: z.string().trim().min(1).max(100),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(40).max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.enum(['Art', 'Exhibition', 'Creative']),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(true),
    cover: image().optional(),
    coverAlt: z.string().trim().optional(),
    ogImage: image().optional(),
    ogImageAlt: z.string().trim().optional(),
  }).refine((entry) => !entry.cover || Boolean(entry.coverAlt), {
    message: 'カバー画像を使う場合は、内容を説明する coverAlt も記入してください。',
    path: ['coverAlt'],
  }).refine((entry) => !entry.ogImage || Boolean(entry.ogImageAlt), {
    message: '記事専用OGP画像を使う場合は、内容を説明する ogImageAlt も記入してください。',
    path: ['ogImageAlt'],
  }),
});

export const collections = { blog };
