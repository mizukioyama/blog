import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { categories } from '../lib/categories';

const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error('astro.config.mjs に site を設定してください。');
  const baseUrl = new URL(import.meta.env.BASE_URL, site);
  const posts = (await getCollection('blog')).filter((post) => !post.data.draft);
  const paths = ['', ...categories.map((category) => 'categories/' + category.slug + '/'), ...posts.map((post) => 'posts/' + post.data.slug + '/')];
  const urls = paths.map((path) => '<url><loc>' + escapeXml(new URL(path, baseUrl).href) + '</loc></url>').join('');
  return new Response('<?xml version="1.0" encoding="UTF-8"?>' + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + '</urlset>', {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
