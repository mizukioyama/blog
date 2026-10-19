import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArticleFiles, validateArticleFile } from './article-validation.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(repoRoot, 'src/content/blog');
const privateRoot = path.join(repoRoot, '.private-drafts');
const args = process.argv.slice(2);
const publicOnly = args.includes('--public-only');
const unsupportedArgs = args.filter((arg) => arg !== '--public-only');
if (unsupportedArgs.length) {
  console.error('未対応の引数です: ' + unsupportedArgs.join(' '));
  process.exit(2);
}
const issues = [];
const publicFiles = await collectArticleFiles(publicRoot);
const privateFiles = publicOnly
  ? []
  : (await collectArticleFiles(privateRoot)).filter((file) => path.basename(file) === 'index.md');
const seenSlugs = new Set();

for (const file of publicFiles) {
  const result = await validateArticleFile(file);
  const relative = path.relative(publicRoot, file);
  for (const issue of result.issues) issues.push(relative + ': ' + issue);
  const slug = result.data.slug;
  if (typeof slug === 'string') {
    if (seenSlugs.has(slug)) issues.push(relative + ': slug が重複しています (' + slug + ')');
    seenSlugs.add(slug);
  }
}

const privateStatuses = new Map();
for (const file of privateFiles) {
  const relative = path.relative(privateRoot, file);
  const result = await validateArticleFile(file, { privateDraft: true, knownSlugs: seenSlugs });
  for (const issue of result.issues) issues.push(relative + ': ' + issue);
  if (typeof result.data.slug === 'string') seenSlugs.add(result.data.slug);
  if (result.data.workflowStatus) {
    privateStatuses.set(result.data.workflowStatus, (privateStatuses.get(result.data.workflowStatus) ?? 0) + 1);
  }
}

if (issues.length) {
  console.error('記事の事前検証で問題が見つかりました:');
  for (const issue of issues) console.error('- ' + issue);
  process.exitCode = 1;
} else if (publicOnly) {
  console.log('記事検証 OK: 公開ソース ' + publicFiles.length + '件。');
  console.log('本番ビルド前検証ではローカル下書きを読み込んでいません。');
} else {
  const statusSummary = [...privateStatuses].map(([status, count]) => status + ' ' + count + '件').join(' / ') || 'なし';
  console.log('記事検証 OK: 公開ソース ' + publicFiles.length + '件、ローカル下書き ' + privateFiles.length + '件 (' + statusSummary + ')。');
  console.log('公開記事は本文・見出し・画像を、ローカル下書きは状態に応じた必須項目を確認しました。');
}
