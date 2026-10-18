import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

export const articleCategories = new Set(['Art', 'Exhibition', 'Creative']);
export const workflowStatuses = new Set(['Draft', 'Review', 'Approved']);
const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function collectArticleFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectArticleFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
  }
  return files.sort();
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function validateImagePath(value, label, directory, issues) {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(label + ' は記事フォルダーからの相対パスで指定してください');
    return;
  }
  const resolved = path.resolve(directory, value);
  if (!isWithinDirectory(directory, resolved)) {
    issues.push(label + ' は記事フォルダー内のファイルを指定してください');
    return;
  }
  try {
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink()) {
      issues.push(label + ' は記事フォルダー内の通常ファイルを指定してください (' + value + ')');
      return;
    }
    const [rootReal, fileReal] = await Promise.all([realpath(directory), realpath(resolved)]);
    if (!isWithinDirectory(rootReal, fileReal)) {
      issues.push(label + ' は記事フォルダー内のファイルを指定してください (' + value + ')');
    }
  } catch {
    issues.push(label + ' の画像ファイルが見つからないか、安全に確認できません (' + value + ')');
  }
}

export async function validateArticleData({ data, content, directory, privateDraft = false, knownSlugs = new Set() }) {
  const issues = [];
  for (const key of ['title', 'slug', 'description', 'pubDate', 'category', 'draft']) {
    if (data[key] === undefined || data[key] === null || data[key] === '') issues.push(key + ' がありません');
  }
  if (typeof data.title !== 'string' || !data.title.trim()) issues.push('title を入力してください');
  else if (data.title.trim().length > 100) issues.push('title は100文字以内にしてください');

  if (data.seoTitle !== undefined) {
    if (typeof data.seoTitle !== 'string' || !data.seoTitle.trim()) issues.push('seoTitle は空にできません');
    else if (data.seoTitle.trim().length > 70) issues.push('seoTitle は70文字以内にしてください');
  }
  if (typeof data.description !== 'string' || data.description.trim().length < 40 || data.description.trim().length > 160) {
    issues.push('description は40〜160文字で記入してください');
  }
  if (typeof data.slug !== 'string' || !validSlug.test(data.slug)) issues.push('slug は小文字英数字とハイフンで記入してください');
  else if (knownSlugs.has(data.slug)) issues.push('slug が既存記事または別の下書きと重複しています');
  if (!articleCategories.has(data.category)) issues.push('category は Art / Exhibition / Creative のいずれかにしてください');

  const pubDate = data.pubDate instanceof Date ? data.pubDate : new Date(data.pubDate);
  if (!(data.pubDate instanceof Date) && (typeof data.pubDate !== 'string' || !data.pubDate.trim())) {
    issues.push('pubDate は有効な日付にしてください');
  } else if (Number.isNaN(pubDate.valueOf())) {
    issues.push('pubDate は有効な日付にしてください');
  }
  if (typeof data.draft !== 'boolean') issues.push('draft は true または false を指定してください');
  if (!Array.isArray(data.tags ?? []) || (data.tags ?? []).some((tag) => typeof tag !== 'string' || !tag.trim())) {
    issues.push('tags は空でない文字列の配列にしてください');
  }

  let completeArticle = data.draft === false;
  if (privateDraft) {
    if (!workflowStatuses.has(data.workflowStatus)) issues.push('workflowStatus は Draft / Review / Approved のいずれかにしてください');
    if (data.draft !== true) issues.push('ローカル下書きは draft: true にしてください');
    completeArticle = data.workflowStatus === 'Review' || data.workflowStatus === 'Approved';
  }
  if (completeArticle) {
    const plainText = content.replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]+\)/g, ' ').replace(/<[^>]+>/g, ' ').replace(/[\\*_>#-]/g, ' ').trim();
    if (plainText.length < 250) issues.push('確認待ちに進める記事本文は250文字以上にしてください');
    if (!content.split('\n').some((line) => line.startsWith('## '))) issues.push('記事に ## 見出しを1つ以上追加してください');
    if (content.includes('ここに記入') || content.includes('本文はまだ作成されていません')) issues.push('本文にテンプレート用の仮文が残っています');
  }

  for (const [key, altKey] of [['cover', 'coverAlt'], ['ogImage', 'ogImageAlt']]) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    await validateImagePath(value, key, directory, issues);
    if (typeof data[altKey] !== 'string' || !data[altKey].trim()) issues.push(key + ' を使う場合は ' + altKey + ' を記入してください');
  }

  const markdownImages = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of content.matchAll(markdownImages)) {
    const [, alt, imagePath] = match;
    if (!alt.trim()) issues.push('本文画像に代替テキストを記入してください');
    if (/^(?:[a-z]+:|\/\/)/i.test(imagePath)) continue;
    await validateImagePath(imagePath, '本文画像', directory, issues);
  }
  return issues;
}

export async function validateArticleFile(file, options = {}) {
  const source = await readFile(file, 'utf8');
  let parsed;
  try {
    parsed = matter(source);
  } catch (error) {
    return { data: {}, content: '', source, issues: ['frontmatterを読み取れません (' + error.message + ')'] };
  }
  const issues = await validateArticleData({
    data: parsed.data,
    content: parsed.content,
    directory: path.dirname(file),
    ...options,
  });
  return { data: parsed.data, content: parsed.content, source, issues };
}
