import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const root = fileURLToPath(new URL('../src/content/blog/', import.meta.url));
const allowedCategories = new Set(['Art', 'Exhibition', 'Creative']);
const issues = [];
const slugs = new Map();
const files = [];

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
  }
}

await walk(root);
let draftCount = 0;
for (const file of files) {
  const relative = path.relative(root, file);
  const source = await readFile(file, 'utf8');
  let parsed;
  try { parsed = matter(source); }
  catch (error) { issues.push(relative + ': frontmatterを読み取れません (' + error.message + ')'); continue; }
  const { data, content } = parsed;
  for (const key of ['title', 'slug', 'description', 'pubDate', 'category', 'draft']) {
    if (data[key] === undefined || data[key] === null || data[key] === '') issues.push(relative + ': ' + key + ' がありません');
  }
  if (typeof data.title === 'string' && data.title.trim().length > 100) issues.push(relative + ': title は100文字以内にしてください');
  if (typeof data.description !== 'string' || data.description.trim().length < 40 || data.description.trim().length > 160) issues.push(relative + ': description は40〜160文字で記入してください');
  if (typeof data.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) issues.push(relative + ': slug は小文字英数字とハイフンで記入してください');
  else if (slugs.has(data.slug)) issues.push(relative + ': slug が ' + slugs.get(data.slug) + ' と重複しています');
  else slugs.set(data.slug, relative);
  if (!allowedCategories.has(data.category)) issues.push(relative + ': category は Art / Exhibition / Creative のいずれかにしてください');
  if (!(data.pubDate instanceof Date) || Number.isNaN(data.pubDate.valueOf())) issues.push(relative + ': pubDate は有効な日付にしてください');
  if (typeof data.draft !== 'boolean') issues.push(relative + ': draft は true または false を指定してください');
  if (data.draft === true) draftCount += 1;
  if (data.cover) {
    if (typeof data.cover !== 'string') issues.push(relative + ': cover は記事ファイルからの相対パスで指定してください');
    else {
      try { await access(path.resolve(path.dirname(file), data.cover)); }
      catch { issues.push(relative + ': cover の画像ファイルが見つかりません (' + data.cover + ')'); }
    }
    if (typeof data.coverAlt !== 'string' || !data.coverAlt.trim()) issues.push(relative + ': cover を使う場合は coverAlt を記入してください');
  }
  const plainText = content.replaceAll('#', '').replaceAll('*', '').replaceAll('_', '').trim();
  if (typeof data.draft === 'boolean' && !data.draft) {
    if (plainText.length < 250) issues.push(relative + ': 公開記事の本文が短すぎます（250文字以上を目安にしてください）');
    if (!content.split('\n').some((line) => line.startsWith('## '))) issues.push(relative + ': 公開記事には ## 見出しを1つ以上付けてください');
    if (content.includes('ここに記入') || content.includes('公開前の下書きサンプル')) issues.push(relative + ': 公開記事にテンプレート用の仮文が残っています');
  }
}

if (issues.length) {
  console.error('記事の事前検証で問題が見つかりました:');
  for (const issue of issues) console.error('- ' + issue);
  process.exitCode = 1;
} else {
  console.log('記事検証 OK: ' + files.length + '件を確認しました（下書き ' + draftCount + '件）。');
  console.log('Astro content schemaは npm run check / npm run build で続けて検証されます。');
}
