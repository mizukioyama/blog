import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import matter from 'gray-matter';

const runtimeProcess = (globalThis as typeof globalThis & {
  process?: { env?: { BLOG_LOAD_LOCAL_DRAFTS?: string; BLOG_PRODUCTION_BUILD?: string } };
}).process;
const loadLocalDrafts = runtimeProcess?.env?.BLOG_LOAD_LOCAL_DRAFTS === '1';
const isProductionBuild = runtimeProcess?.env?.BLOG_PRODUCTION_BUILD === '1';

type MarkdownDirent = { name: string; isDirectory(): boolean; isFile(): boolean };
type DraftFileSystem = {
  readdir(directory: URL, options: { withFileTypes: true }): Promise<MarkdownDirent[]>;
  readFile(file: URL, encoding: 'utf8'): Promise<string>;
};

function escapeGlobPath(path: string): string {
  const globMeta = new Set(['\\', '(', ')', '[', ']', '{', '}', '*', '?', '|']);
  return [...path].map((character, index) =>
    globMeta.has(character) || (character === '!' && index === 0) ? '\\' + character : character
  ).join('');
}

async function collectMarkdownFiles(fs: DraftFileSystem, directory: URL, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fs, new URL(encodeURIComponent(entry.name) + '/', directory), relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(relativePath);
    }
  }
  return files;
}

const blogLoader: ReturnType<typeof glob> = {
  name: 'blog-published-content',
  async load(context) {
    const base = new URL('src/content/blog/', context.config.root);
    let pattern: string | string[] = '**/*.md';
    if (isProductionBuild) {
      const fsModuleName: string = 'node:fs/promises';
      const fs = await import(/* @vite-ignore */ fsModuleName) as unknown as DraftFileSystem;
      const files = await collectMarkdownFiles(fs, base);
      pattern = [];
      for (const file of files) {
        const fileUrl = new URL(file.split('/').map(encodeURIComponent).join('/'), base);
        const metadata = matter(await fs.readFile(fileUrl, 'utf8')).data;
        if (metadata.draft === false) pattern.push(escapeGlobPath(file));
      }
    }
    await glob({ base, pattern }).load(context);
  },
};

const blog = defineCollection({
  loader: blogLoader,
  schema: ({ image }) => z.object({
    title: z.string().trim().min(1).max(100),
    seoTitle: z.string().trim().min(1).max(70).optional(),
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

const localDrafts = defineCollection({
  // Private article data and its image() references must never enter a production
  // content sync. Loading is opt-in for local preview and denied by default.
  loader: loadLocalDrafts
    ? glob({ base: './.private-drafts', pattern: '**/index.md' })
    : async () => [],
  schema: z.object({
    title: z.string().trim().min(1).max(100),
    seoTitle: z.string().trim().min(1).max(70).optional(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(40).max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.enum(['Art', 'Exhibition', 'Creative']),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(true),
    workflowStatus: z.enum(['Draft', 'Review', 'Approved']),
    cover: z.string().trim().min(1).optional(),
    coverAlt: z.string().trim().optional(),
    ogImage: z.string().trim().min(1).optional(),
    ogImageAlt: z.string().trim().optional(),
  }).refine((entry) => entry.draft, {
    message: 'ローカル下書きでは draft: true を指定してください。',
    path: ['draft'],
  }).refine((entry) => !entry.cover || Boolean(entry.coverAlt), {
    message: 'カバー画像を使う場合は、内容を説明する coverAlt も記入してください。',
    path: ['coverAlt'],
  }).refine((entry) => !entry.ogImage || Boolean(entry.ogImageAlt), {
    message: '記事専用OGP画像を使う場合は、内容を説明する ogImageAlt も記入してください。',
    path: ['ogImageAlt'],
  }),
});

export const collections = { blog, localDrafts };
