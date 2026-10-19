import { createHash, randomUUID } from 'node:crypto';
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, link, unlink, rmdir, rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import { collectArticleFiles, validateArticleData } from './article-validation.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultDraftsDir = path.join(repoRoot, '.private-drafts');
const defaultContentDir = path.join(repoRoot, 'src/content/blog');
const defaultPlansDir = path.join(repoRoot, '.private-publication');
const defaultBackupsDir = path.join(repoRoot, '.private-draft-backups');
const defaultOgImage = path.join(repoRoot, 'public/og-image.png');
const siteBaseUrl = 'https://mizukioyama.github.io/blog/';
const privateMarker = '.publication-in-progress.json';
const humanReviewChecklist = [
  'ARTICLE_WRITING_RULES.mdに沿った文章・事実・既存記事との意味上の重複確認',
  'アイキャッチの内容・権利・表示品質とaltの確認',
  '本文リンクの遷移先と外部情報の根拠確認',
  '本人確認が必要な経験・事実・公開予定日の確認',
  '公開内容とGitHub Pagesへの公開操作を別々に明示承認',
];
const categoryDirectories = new Map([['Art', 'art'], ['Exhibition', 'exhibition'], ['Creative', 'creative']]);
const validId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validCommit = /^[a-f0-9]{40}$/i;
const privateDraftPattern = /^\.article-save-recovery-/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(normalizeValue(value));
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function assertValidId(value, label) {
  if (typeof value !== 'string' || !validId.test(value)) throw new Error(label + ' の形式が正しくありません。');
}

function categoryDirectory(category) {
  const directory = categoryDirectories.get(category);
  if (!directory) throw new Error('カテゴリーを公開先へ変換できません。');
  return directory;
}

function publicTargetDirectory(category, slug) {
  assertValidId(slug, '記事slug');
  return path.posix.join(categoryDirectory(category), slug);
}

function articlePublicUrl(slug) {
  assertValidId(slug, '記事slug');
  return new URL('posts/' + slug + '/', siteBaseUrl).href;
}

function sourceContentDigest(data, content) {
  const comparable = { ...data };
  delete comparable.workflowStatus;
  delete comparable.updatedDate;
  return sha256(stableJson({ data: comparable, content }));
}

function candidateDigest({ targetDirectory, publicUrl, files, source }) {
  return sha256(stableJson({
    targetDirectory,
    publicUrl,
    source: {
      draftId: source.draftId,
      slug: source.slug,
      contentSha256: source.contentSha256,
      briefSha256: source.briefSha256,
    },
    files: files.map(({ path: filePath, sha256: fileHash, bytes, kind }) => ({
      path: filePath, sha256: fileHash, bytes, kind,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  }));
}

async function assertDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(directory);
  if (create) await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('公開ワークフローの保存先は通常のディレクトリにしてください。');
  return realpath(resolved);
}

async function assertRegularFile(file, { optional = false } = {}) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('通常ファイル以外は公開候補に使用できません。');
    return realpath(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeExclusive(file, contents) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  await handle.close();
}

function cleanImageReference(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('画像参照が空です。');
  const raw = value.trim().replace(/^<|>$/g, '');
  if (raw.includes('\\') || raw.includes('\0') || path.isAbsolute(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    throw new Error('公開用画像は記事フォルダー内の相対パスで指定してください。');
  }
  const stripped = raw.replace(/^\.\//, '');
  const segments = stripped.split('/');
  if (!stripped || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('画像パスに空または親ディレクトリ要素を使用できません。');
  }
  const normalized = path.posix.normalize(stripped);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('画像パスが記事フォルダーの外へ出ています。');
  }
  return normalized;
}

function collectImageReferences(data, content, issues) {
  const references = new Map();
  for (const key of ['cover', 'ogImage']) {
    if (data[key] === undefined || data[key] === null || data[key] === '') continue;
    try {
      const relativePath = cleanImageReference(data[key]);
      references.set(relativePath, key);
    } catch (error) {
      issues.push(key + ': ' + error.message);
    }
  }
  const imagePattern = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of content.matchAll(imagePattern)) {
    const [, alt, rawPath] = match;
    if (!alt.trim()) issues.push('本文画像に代替テキストを記入してください。');
    try {
      const relativePath = cleanImageReference(rawPath);
      if (!references.has(relativePath)) references.set(relativePath, 'body-image');
    } catch (error) {
      issues.push('本文画像: ' + error.message);
    }
  }
  if (/<img\b/i.test(content)) issues.push('HTMLのimg要素は公開候補に使えません。Markdown画像へ置き換えてください。');
  return references;
}

function validateBlogRoute(target, { publicSlugs, currentSlug }) {
  let url;
  try { url = new URL(target, siteBaseUrl); } catch { return false; }
  const base = new URL(siteBaseUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith('/blog/')) return true;
  const route = url.pathname.slice('/blog/'.length).replace(/\.html$/, '').replace(/\/+$/, '');
  if (!route || route === 'index') return true;
  const category = /^categories\/([a-z]+)$/.exec(route);
  if (category) return [...categoryDirectories.values()].includes(category[1]);
  const post = /^posts\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(route);
  if (post) return post[1] === currentSlug || publicSlugs.has(post[1]);
  return false;
}

function inspectMarkdownLinks(content, issues, { publicSlugs, currentSlug }) {
  const matches = [...content.matchAll(/\[[^\]]+\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)];
  for (const [, raw] of matches) {
    const target = raw.replace(/^<|>$/g, '');
    if (/^(?:javascript|data|file|vbscript):/i.test(target)) {
      issues.push('本文リンクに安全でないURLスキームがあります。');
      continue;
    }
    if (/^https?:\/\//i.test(target)) {
      try {
        const url = new URL(target);
        if (url.origin === new URL(siteBaseUrl).origin && !validateBlogRoute(target, { publicSlugs, currentSlug })) {
          issues.push('ブログ内リンクの公開先を確認できません: ' + url.pathname);
        }
      } catch { issues.push('本文に形式が正しくないURLがあります。'); }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^mailto:/i.test(target)) {
      issues.push('本文リンクに未対応のURLスキームがあります。');
      continue;
    }
    if (target.startsWith('/blog/') && !validateBlogRoute(target, { publicSlugs, currentSlug })) {
      issues.push('ブログ内リンクの公開先を確認できません: ' + target);
    }
  }
  return matches.length;
}

function privacyIssues(source, draftId) {
  const issues = [];
  if (source.includes(draftId)) issues.push('記事本文または公開メタデータに下書きIDが含まれています。');
  if (/\/(?:Users|home)\/[^\s/]+(?:\/|\b)/.test(source)) issues.push('記事本文または公開メタデータに個人用の絶対パスが含まれています。');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/.test(source)) issues.push('秘密情報らしき文字列が含まれています。');
  return issues;
}

async function readDraftSnapshot({ draftsDir, draftId }) {
  assertValidId(draftId, '下書きID');
  const draftsRoot = await assertDirectory(draftsDir);
  const directory = path.resolve(draftsRoot, draftId);
  if (!inside(draftsRoot, directory)) throw new Error('下書きの保存先が許可フォルダーの外です。');
  const directoryReal = await assertDirectory(directory);
  if (!inside(draftsRoot, directoryReal)) throw new Error('下書きフォルダーが許可範囲外を指しています。');
  if ((await readdir(directoryReal)).some((name) => privateDraftPattern.test(name))) {
    throw new Error('中断した下書き保存の回復データがあります。先に article:recover で復旧してください。');
  }
  const indexFile = await assertRegularFile(path.join(directoryReal, 'index.md'));
  if (!inside(directoryReal, indexFile)) throw new Error('下書き index.md が許可範囲外を指しています。');
  const briefFile = await assertRegularFile(path.join(directoryReal, 'brief.md'), { optional: true });
  const [sourceBuffer, brief] = await Promise.all([
    readFile(indexFile),
    briefFile ? readFile(briefFile, 'utf8') : Promise.resolve(''),
  ]);
  let parsed;
  try { parsed = matter(sourceBuffer.toString('utf8')); }
  catch (error) { throw new Error('下書きfrontmatterを読み取れません: ' + error.message); }
  return {
    draftId, directory: directoryReal, indexFile, sourceBuffer,
    source: sourceBuffer.toString('utf8'), data: parsed.data, content: parsed.content, brief,
  };
}

async function knownSlugs({ contentDir, draftsDir, currentIndexFile }) {
  const slugs = new Set();
  const titles = new Set();
  const publicSlugs = new Set();
  for (const file of await collectArticleFiles(contentDir)) {
    if (path.basename(file) !== 'index.md') continue;
    const parsed = matter(await readFile(file, 'utf8'));
    if (typeof parsed.data.slug === 'string') {
      slugs.add(parsed.data.slug);
      if (parsed.data.draft === false) publicSlugs.add(parsed.data.slug);
    }
    if (typeof parsed.data.title === 'string') titles.add(parsed.data.title.trim().replace(/\s+/g, ' '));
  }
  for (const file of (await collectArticleFiles(draftsDir)).filter((item) => path.basename(item) === 'index.md')) {
    const fileReal = await realpath(file);
    if (fileReal === currentIndexFile) continue;
    const parsed = matter(await readFile(file, 'utf8'));
    if (typeof parsed.data.slug === 'string') slugs.add(parsed.data.slug);
    if (typeof parsed.data.title === 'string') titles.add(parsed.data.title.trim().replace(/\s+/g, ' '));
  }
  return { slugs, titles, publicSlugs };
}

async function assertNoSymlinkSegments(directory, relativePath) {
  let current = directory;
  const pieces = relativePath.split('/');
  for (let index = 0; index < pieces.length; index += 1) {
    current = path.join(current, pieces[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('画像パスにシンボリックリンクは使用できません。');
    if (index < pieces.length - 1 && !info.isDirectory()) throw new Error('画像パスの親要素がディレクトリではありません。');
  }
}

async function readContainedAsset(directory, relativePath) {
  await assertNoSymlinkSegments(directory, relativePath);
  const resolved = path.resolve(directory, ...relativePath.split('/'));
  if (!inside(directory, resolved)) throw new Error('画像が記事フォルダーの外を指しています。');
  const file = await assertRegularFile(resolved);
  if (!inside(directory, file)) throw new Error('画像のシンボリックリンクが記事フォルダーの外を指しています。');
  const contents = await readFile(file);
  if (!contents.length) throw new Error('空の画像ファイルは公開候補に使用できません。');
  if (contents.length > 20 * 1024 * 1024) throw new Error('画像ファイルは20 MB以下にしてください。');
  return contents;
}

function publicFrontmatter(data) {
  const allowed = ['title', 'seoTitle', 'slug', 'description', 'pubDate', 'updatedDate', 'category', 'tags', 'cover', 'coverAlt', 'ogImage', 'ogImageAlt'];
  const result = {};
  for (const key of allowed) if (data[key] !== undefined) result[key] = data[key];
  result.draft = false;
  return result;
}

function unresolvedBriefMarker(brief) {
  return /(?:未確認|確認待ち|要確認|未入力|\bTODO\b|\bTBD\b|\[ \])/i.test(brief);
}

export async function preparePublication({
  draftsDir = defaultDraftsDir,
  contentDir = defaultContentDir,
  plansDir = defaultPlansDir,
  backupsDir = defaultBackupsDir,
  publicOgImage = defaultOgImage,
  draftId,
  now = new Date(),
}) {
  const draft = await readDraftSnapshot({ draftsDir, draftId });
  if (draft.data.workflowStatus !== 'Review' || draft.data.draft !== true) {
    throw new Error('公開候補は draft: true のReview下書きからのみ準備できます。');
  }
  const issues = [];
  const others = await knownSlugs({ contentDir, draftsDir, currentIndexFile: draft.indexFile });
  const validationIssues = await validateArticleData({
    data: draft.data,
    content: draft.content,
    directory: draft.directory,
    privateDraft: true,
    knownSlugs: others.slugs,
  });
  issues.push(...validationIssues);
  if (typeof draft.data.seoTitle !== 'string' || !draft.data.seoTitle.trim()) issues.push('seoTitle を設定してください。');
  if (!draft.data.cover) issues.push('公開用アイキャッチを設定してください。');
  if (!draft.data.coverAlt?.trim()) issues.push('アイキャッチのcoverAltを設定してください。');
  const normalizedTitle = String(draft.data.title ?? '').trim().replace(/\s+/g, ' ');
  if (others.titles.has(normalizedTitle)) issues.push('同じタイトルの公開記事または別の下書きがあります。');
  if (!draft.brief.trim()) issues.push('事実確認と公開予定日を確認するbrief.mdがありません。');
  const openBriefMarker = unresolvedBriefMarker(draft.brief);
  if (openBriefMarker) issues.push('brief.md に未確認・要確認の事実が残っています。本人確認を完了してから候補を作成してください。');

  const linksCount = inspectMarkdownLinks(draft.content, issues, { publicSlugs: others.publicSlugs, currentSlug: draft.data.slug });
  const references = collectImageReferences(draft.data, draft.content, issues);
  const publicData = publicFrontmatter(draft.data);
  const publicSource = matter.stringify(draft.content, publicData);
  issues.push(...privacyIssues(publicSource, draftId));

  const ogDefaultFile = await assertRegularFile(publicOgImage, { optional: true });
  if (!draft.data.ogImage && !ogDefaultFile) issues.push('記事専用ogImageもサイト標準OGP画像も見つかりません。');
  const uniqueIssues = [...new Set(issues)];
  if (uniqueIssues.length) throw new Error('公開候補の自動検証に失敗しました:\n- ' + uniqueIssues.join('\n- '));

  const root = await assertDirectory(plansDir, { create: true });
  const draftsRoot = await assertDirectory(draftsDir);
  const contentRoot = await assertDirectory(contentDir);
  let backupsRoot = path.resolve(backupsDir);
  try { backupsRoot = await assertDirectory(backupsRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (root === draftsRoot || inside(draftsRoot, root) || inside(root, draftsRoot) || root === contentRoot || inside(contentRoot, root) || inside(root, contentRoot) || root === backupsRoot || inside(backupsRoot, root) || inside(root, backupsRoot)) {
    throw new Error('公開候補の保管先は下書き・バックアップ・公開記事フォルダーと分離してください。');
  }
  const assets = [];
  for (const [relativePath, kind] of references) {
    const contents = await readContainedAsset(draft.directory, relativePath);
    assets.push({ relativePath, kind, contents, sha256: sha256(contents), bytes: contents.length });
  }
  const payloadFiles = [
    { relativePath: 'index.md', kind: 'article', contents: Buffer.from(publicSource), sha256: sha256(publicSource), bytes: Buffer.byteLength(publicSource) },
    ...assets.map(({ relativePath, kind, contents, sha256: fileHash, bytes }) => ({
      relativePath, kind, contents, sha256: fileHash, bytes,
    })),
  ];
  const targetDirectory = publicTargetDirectory(draft.data.category, draft.data.slug);
  const publicUrl = articlePublicUrl(draft.data.slug);
  const files = payloadFiles.map(({ relativePath, kind, sha256: fileHash, bytes }) => ({
    path: relativePath, kind, sha256: fileHash, bytes,
  })).sort((a, b) => a.path.localeCompare(b.path));
  const sourceBinding = {
    draftId, slug: draft.data.slug,
    contentSha256: sourceContentDigest(draft.data, draft.content),
    briefSha256: sha256(draft.brief),
  };
  const candidateSha256 = candidateDigest({ targetDirectory, publicUrl, files, source: sourceBinding });
  const planId = 'publication-' + now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
  const tempDirectory = path.join(root, '.' + planId + '.' + randomUUID() + '.tmp');
  const planDirectory = path.join(root, planId);
  await mkdir(tempDirectory, { mode: 0o700 });
  try {
    const payloadDirectory = path.join(tempDirectory, 'payload');
    await mkdir(payloadDirectory, { mode: 0o700 });
    for (const file of payloadFiles) await writeExclusive(path.join(payloadDirectory, ...file.relativePath.split('/')), file.contents);
    const manifest = {
      schemaVersion: 1,
      planId,
      createdAt: now.toISOString(),
      source: {
        draftId,
        slug: draft.data.slug,
        statusAtPreparation: 'Review',
        indexSha256: sha256(draft.sourceBuffer),
        briefSha256: sha256(draft.brief),
        contentSha256: sourceBinding.contentSha256,
        briefSha256: sourceBinding.briefSha256,
      },
      candidate: {
        title: draft.data.title,
        category: draft.data.category,
        slug: draft.data.slug,
        publishDate: draft.data.pubDate instanceof Date ? draft.data.pubDate.toISOString().slice(0, 10) : String(draft.data.pubDate),
        seoTitle: draft.data.seoTitle,
        metaDescription: draft.data.description,
        cover: draft.data.cover,
        coverAlt: draft.data.coverAlt,
        ogImage: draft.data.ogImage ?? 'site-default: /blog/og-image.png',
        ogImageAlt: draft.data.ogImageAlt ?? 'site-default alt text',
        publicUrl,
        targetDirectory,
        targetFiles: files.map((file) => path.posix.join(targetDirectory, file.path)),
        files,
        candidateSha256,
      },
      checks: {
        automated: [
          'Review状態とdraft:true',
          'frontmatter・本文・SEO項目',
          'slug・タイトル重複',
          'ローカル画像のパス・通常ファイル・シンボリックリンク',
          '本文リンクの危険なスキーム・ブログ内公開先',
          '個人用絶対パス・秘密情報・下書きID',
        ],
        markdownLinkCount: linksCount,
        localImageCount: assets.length,
        openBriefMarker: unresolvedBriefMarker(draft.brief),
        humanReviewRequired: humanReviewChecklist,
      },
    };
    await writeExclusive(path.join(tempDirectory, 'plan.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(tempDirectory, planDirectory);
    return summarizePlan(manifest);
  } catch (error) {
    const tempInfo = await lstat(tempDirectory).catch(() => null);
    if (tempInfo?.isDirectory() && !tempInfo.isSymbolicLink()) {
      // This temporary directory is created by this invocation and never contains source drafts.
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

function summarizePlan(manifest) {
  return {
    planId: manifest.planId,
    candidateSha256: manifest.candidate.candidateSha256,
    title: manifest.candidate.title,
    category: manifest.candidate.category,
    slug: manifest.candidate.slug,
    publishDate: manifest.candidate.publishDate,
    seoTitle: manifest.candidate.seoTitle,
    metaDescription: manifest.candidate.metaDescription,
    cover: manifest.candidate.cover,
    coverAlt: manifest.candidate.coverAlt,
    ogImage: manifest.candidate.ogImage,
    ogImageAlt: manifest.candidate.ogImageAlt,
    publicUrl: manifest.candidate.publicUrl,
    targetFiles: manifest.candidate.targetFiles,
    openBriefMarker: manifest.checks.openBriefMarker,
    humanReviewRequired: humanReviewChecklist,
  };
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) return false;
  const pieces = value.split('/');
  return pieces.every((piece) => piece && piece !== '.' && piece !== '..') && path.posix.normalize(value) === value;
}

async function listRegularFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const fullPath = path.join(directory, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error('公開候補にシンボリックリンクがあります。');
    if (info.isDirectory()) {
      const nested = await listRegularFiles(fullPath, relative);
      if (!nested.length) throw new Error('公開候補payloadに空ディレクトリがあります。');
      result.push(...nested);
    }
    else if (info.isFile()) result.push(relative);
    else throw new Error('公開候補に通常ファイル以外があります。');
  }
  return result.sort();
}

async function readAndVerifyPlan({ plansDir, planId }) {
  assertValidId(planId, '公開候補ID');
  const root = await assertDirectory(plansDir);
  const directory = path.resolve(root, planId);
  if (!inside(root, directory)) throw new Error('公開候補の保存先が許可範囲外です。');
  const planDirectory = await assertDirectory(directory);
  if (!inside(root, planDirectory)) throw new Error('公開候補が許可範囲外を指しています。');
  const planFile = await assertRegularFile(path.join(planDirectory, 'plan.json'));
  let manifest;
  try { manifest = JSON.parse(await readFile(planFile, 'utf8')); }
  catch (error) { throw new Error('公開候補の計画ファイルを読み取れません: ' + error.message); }
  if (manifest.schemaVersion !== 1 || manifest.planId !== planId || !manifest.candidate) throw new Error('公開候補の形式が正しくありません。');
  const { category, slug, publicUrl, targetDirectory, files, candidateSha256 } = manifest.candidate;
  if (targetDirectory !== publicTargetDirectory(category, slug) || publicUrl !== articlePublicUrl(slug)) throw new Error('公開候補の配置先またはURLが一致しません。');
  if (!Array.isArray(files) || !files.length) throw new Error('公開候補のファイル一覧がありません。');
  const filePaths = new Set();
  for (const file of files) {
    if (!safeRelativePath(file.path) || filePaths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 1) {
      throw new Error('公開候補のファイル一覧が安全ではありません。');
    }
    filePaths.add(file.path);
  }
  if (!filePaths.has('index.md')) throw new Error('公開候補にindex.mdがありません。');
  const payloadDirectory = path.join(planDirectory, 'payload');
  const payloadReal = await assertDirectory(payloadDirectory);
  if (!inside(planDirectory, payloadReal)) throw new Error('公開候補のpayloadが許可範囲外です。');
  const actualPaths = await listRegularFiles(payloadReal);
  if (actualPaths.length !== filePaths.size || actualPaths.some((item) => !filePaths.has(item))) throw new Error('公開候補に予定外または不足しているファイルがあります。');
  for (const file of files) {
    const target = path.join(payloadReal, ...file.path.split('/'));
    const realFile = await assertRegularFile(target);
    if (!inside(payloadReal, realFile)) throw new Error('公開候補ファイルがpayloadの外を指しています。');
    const contents = await readFile(realFile);
    if (contents.length !== file.bytes || sha256(contents) !== file.sha256) throw new Error('公開候補ファイルが作成後に変更されています。');
  }
  if (manifest.source.statusAtPreparation !== 'Review' || manifest.checks?.openBriefMarker !== false || stableJson(manifest.checks?.humanReviewRequired) !== stableJson(humanReviewChecklist)) {
    throw new Error('公開候補の確認項目が変更されています。候補を作り直してください。');
  }
  if (candidateDigest({ targetDirectory, publicUrl, files, source: manifest.source }) !== candidateSha256) throw new Error('公開候補の承認用ハッシュが一致しません。');
  const index = matter(await readFile(path.join(payloadReal, 'index.md'), 'utf8'));
  if (index.data.slug !== slug || index.data.draft !== false || Object.hasOwn(index.data, 'workflowStatus')) throw new Error('公開候補frontmatterが公開条件を満たしません。');
  const plannedDate = index.data.pubDate instanceof Date ? index.data.pubDate.toISOString().slice(0, 10) : String(index.data.pubDate);
  const expectedOgImage = index.data.ogImage ?? 'site-default: /blog/og-image.png';
  const expectedOgAlt = index.data.ogImageAlt ?? 'site-default alt text';
  if (manifest.candidate.title !== index.data.title || manifest.candidate.category !== index.data.category ||
      manifest.candidate.publishDate !== plannedDate || manifest.candidate.seoTitle !== index.data.seoTitle ||
      manifest.candidate.metaDescription !== index.data.description || manifest.candidate.cover !== index.data.cover ||
      manifest.candidate.coverAlt !== index.data.coverAlt || manifest.candidate.ogImage !== expectedOgImage ||
      manifest.candidate.ogImageAlt !== expectedOgAlt) {
    throw new Error('公開候補の表示情報がpayloadと一致しません。候補を作り直してください。');
  }
  const expectedTargetFiles = files.map((file) => path.posix.join(targetDirectory, file.path)).sort();
  if (stableJson(manifest.candidate.targetFiles) !== stableJson(expectedTargetFiles)) throw new Error('公開候補の配置ファイル一覧がpayloadと一致しません。');
  const articleIssues = await validateArticleData({ data: index.data, content: index.content, directory: payloadReal });
  if (articleIssues.length) throw new Error('公開候補の最終検証に失敗しました:\n- ' + articleIssues.join('\n- '));
  return { root, directory: planDirectory, payloadDirectory: payloadReal, manifest };
}

async function ensureNormalChildDirectory(parent, name) {
  const parentReal = await assertDirectory(parent);
  const target = path.join(parentReal, name);
  try { await mkdir(target, { mode: 0o755 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const targetReal = await assertDirectory(target);
  if (!inside(parentReal, targetReal)) throw new Error('公開先ディレクトリが許可範囲外を指しています。');
  return targetReal;
}

async function ensureRelativeParent(root, relativeFile) {
  const pieces = path.posix.dirname(relativeFile).split('/').filter((piece) => piece !== '.');
  let current = await assertDirectory(root);
  for (const piece of pieces) {
    const next = path.join(current, piece);
    try { await mkdir(next, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(next);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('公開先アセットの親要素に通常ディレクトリ以外があります。');
    const nextReal = await realpath(next);
    if (!inside(root, nextReal)) throw new Error('公開先アセットが記事フォルダーの外を指しています。');
    current = nextReal;
  }
  return current;
}

async function writeNoReplace(file, contents, linkFile = link) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await linkFile(temp, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}

async function verifyTargetFiles(directory, files) {
  const expected = files.map((file) => file.path).sort();
  const actual = (await listRegularFiles(directory)).filter((file) => file !== privateMarker);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) return false;
  for (const file of files) {
    const content = await readFile(path.join(directory, ...file.path.split('/')));
    if (content.length !== file.bytes || sha256(content) !== file.sha256) return false;
  }
  return true;
}

export async function materializePublication({
  draftsDir = defaultDraftsDir,
  contentDir = defaultContentDir,
  plansDir = defaultPlansDir,
  planId,
  candidateSha256: approvedCandidateSha256,
  dryRun = false,
  linkFile = link,
}) {
  if (!/^[a-f0-9]{64}$/.test(approvedCandidateSha256 ?? '')) {
    throw new Error('ユーザーが確認した公開候補のcandidate SHA-256を指定してください。');
  }
  const { payloadDirectory, manifest } = await readAndVerifyPlan({ plansDir, planId });
  const candidate = manifest.candidate;
  if (approvedCandidateSha256 !== candidate.candidateSha256) throw new Error('指定したcandidate SHA-256が公開候補と一致しません。');
  const draft = await readDraftSnapshot({ draftsDir, draftId: manifest.source.draftId });
  if (draft.data.workflowStatus !== 'Approved' || draft.data.draft !== true) {
    throw new Error('公開用ファイルの準備には、記事内容を本人承認済みのApproved下書きが必要です。');
  }
  if (draft.data.slug !== candidate.slug || sourceContentDigest(draft.data, draft.content) !== manifest.source.contentSha256 || sha256(draft.brief) !== manifest.source.briefSha256 || unresolvedBriefMarker(draft.brief)) {
    throw new Error('公開候補作成後に下書き内容が変わっています。再レビューして公開候補を作り直してください。');
  }
  const publishedFiles = await collectArticleFiles(contentDir);
  const expectedArticlePath = path.resolve(contentDir, categoryDirectory(candidate.category), candidate.slug, 'index.md');
  for (const file of publishedFiles) {
    if (path.basename(file) !== 'index.md') continue;
    const current = matter(await readFile(file, 'utf8'));
    if (current.data.slug === candidate.slug && path.resolve(file) !== expectedArticlePath) {
      throw new Error('同じslugの記事が公開フォルダーにあります。既存記事は上書きしません。');
    }
  }
  const currentDraftReal = await realpath(draft.indexFile);
  for (const file of (await collectArticleFiles(draftsDir)).filter((item) => path.basename(item) === 'index.md')) {
    if (await realpath(file) === currentDraftReal) continue;
    const otherDraft = matter(await readFile(file, 'utf8'));
    if (otherDraft.data.slug === candidate.slug) throw new Error('同じslugの別下書きがあります。既存記事・下書きは上書きしません。');
  }
  const currentIssues = await validateArticleData({
    data: draft.data,
    content: draft.content,
    directory: draft.directory,
    privateDraft: true,
  });
  if (currentIssues.length) throw new Error('承認済み下書きの最終検証に失敗しました:\n- ' + currentIssues.join('\n- '));

  const contentRoot = await assertDirectory(contentDir);
  const categoryName = categoryDirectory(candidate.category);
  const targetParentBeforeWrite = path.join(contentRoot, categoryName);
  let parentExists = true;
  try {
    const parentInfo = await lstat(targetParentBeforeWrite);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('公開カテゴリー先が通常のディレクトリではありません。');
  } catch (error) {
    if (error.code === 'ENOENT') parentExists = false;
    else throw error;
  }
  const targetDirectory = path.join(targetParentBeforeWrite, candidate.slug);
  const files = candidate.files;
  const targetFiles = files.map((file) => path.posix.join(candidate.targetDirectory, file.path));
  let targetInfo;
  try { targetInfo = await lstat(targetDirectory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let markerPresent = false;
  if (targetInfo) {
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('公開先に通常ディレクトリ以外があります。');
    const markerPath = path.join(targetDirectory, privateMarker);
    const markerReal = await assertRegularFile(markerPath, { optional: true });
    if (markerReal) {
      const marker = JSON.parse(await readFile(markerReal, 'utf8'));
      if (marker.planId !== planId || marker.candidateSha256 !== candidate.candidateSha256) throw new Error('公開先に別の未完了作業があります。手動確認が必要です。');
      markerPresent = true;
    } else {
      if (await verifyTargetFiles(targetDirectory, files)) {
        return { planId, candidateSha256: candidate.candidateSha256, targetDirectory: candidate.targetDirectory, targetFiles, dryRun, alreadyMaterialized: true };
      }
      throw new Error('公開先が既に存在し、内容が公開候補と異なります。既存記事は上書きしません。');
    }
  }
  if (dryRun) return { planId, candidateSha256: candidate.candidateSha256, targetDirectory: candidate.targetDirectory, targetFiles, dryRun: true, categoryDirectoryWouldBeCreated: !parentExists, alreadyMaterialized: false };

  const targetParent = parentExists ? await assertDirectory(targetParentBeforeWrite) : await ensureNormalChildDirectory(contentDir, categoryName);
  const safeTargetDirectory = path.join(targetParent, candidate.slug);
  if (!markerPresent && !targetInfo) {
    await mkdir(safeTargetDirectory, { mode: 0o755 });
    try {
      await writeExclusive(path.join(safeTargetDirectory, privateMarker), JSON.stringify({ planId, candidateSha256: candidate.candidateSha256 }) + '\n');
    } catch (error) {
      await rmdir(safeTargetDirectory).catch(() => {});
      throw error;
    }
  }
  const writeDirectory = safeTargetDirectory;
  const markerPath = path.join(writeDirectory, privateMarker);
  const payloadFiles = [...files].sort((a, b) => Number(a.path === 'index.md') - Number(b.path === 'index.md'));
  try {
    for (const file of payloadFiles) {
      const safeParent = await ensureRelativeParent(writeDirectory, file.path);
      const destination = path.join(safeParent, path.posix.basename(file.path));
      const source = path.join(payloadDirectory, ...file.path.split('/'));
      try {
        const existingReal = await assertRegularFile(destination);
        const existing = await readFile(existingReal);
        if (existing.length !== file.bytes || sha256(existing) !== file.sha256) throw new Error('公開先の既存ファイルが候補と異なります。上書きしません。');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const sourceBytes = await readFile(source);
        await writeNoReplace(destination, sourceBytes, linkFile);
      }
    }
    if (!await verifyTargetFiles(writeDirectory, files)) throw new Error('公開先のファイル一覧または内容が候補と一致しません。');
    await unlink(markerPath);
  } catch (error) {
    throw new Error('公開候補のローカル配置が未完了です。元の下書き・バックアップはそのままです。再実行でこの候補を安全に再開できます。原因: ' + error.message, { cause: error });
  }
  return { planId, candidateSha256: candidate.candidateSha256, targetDirectory: candidate.targetDirectory, targetFiles, dryRun: false, alreadyMaterialized: false };
}

function htmlAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) attributes.set(match[1].toLowerCase(), match[3]);
  return attributes;
}

function metaContent(html, key) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    if (attrs.get('property') === key || attrs.get('name') === key) return attrs.get('content');
  }
  return undefined;
}

function htmlText(value) {
  return value.replace(/<[^>]+>/g, '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
}

async function fetchPage(url, fetchImpl) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error' });
  if (!response || response.status !== 200) throw new Error('公開URLがHTTP 200ではありません: ' + url);
  return response.text();
}

async function storePrivateResult(planDirectory, record) {
  const resultPath = path.join(planDirectory, 'publication-result.json');
  const source = JSON.stringify(record, null, 2) + '\n';
  const existing = await assertRegularFile(resultPath, { optional: true });
  if (existing) {
    if ((await readFile(existing, 'utf8')) === source) return;
    throw new Error('公開結果の記録が既に存在し、上書きしません。');
  }
  await writeNoReplace(resultPath, Buffer.from(source));
}

export async function verifyLivePublication({
  plansDir = defaultPlansDir,
  planId,
  commitSha,
  workflowSha,
  workflowRunUrl,
  buildStatus,
  deployStatus,
  fetchImpl = globalThis.fetch,
  now = new Date(),
}) {
  const { directory, payloadDirectory, manifest } = await readAndVerifyPlan({ plansDir, planId });
  if (!validCommit.test(commitSha ?? '') || commitSha.toLowerCase() !== workflowSha?.toLowerCase()) {
    throw new Error('公開Commit SHAとGitHub Actions実行対象SHAが一致しません。');
  }
  if (buildStatus !== 'success' || deployStatus !== 'success') throw new Error('GitHub Actionsのbuild・deploy両方が成功していません。');
  let runUrl;
  try { runUrl = new URL(workflowRunUrl); } catch { throw new Error('GitHub Actions実行URLが正しくありません。'); }
  if (runUrl.protocol !== 'https:' || runUrl.hostname !== 'github.com' || !/^\/mizukioyama\/blog\/actions\/runs\/\d+$/.test(runUrl.pathname)) {
    throw new Error('GitHub Actions実行URLが対象リポジトリのrunではありません。');
  }
  if (typeof fetchImpl !== 'function') throw new Error('このNode環境でHTTP検証を利用できません。');
  const candidate = manifest.candidate;
  const categoryUrl = new URL('categories/' + candidate.category.toLowerCase() + '/', siteBaseUrl).href;
  const articleHtml = await fetchPage(candidate.publicUrl, fetchImpl);
  const categoryHtml = await fetchPage(categoryUrl, fetchImpl);
  const title = htmlText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(articleHtml)?.[1] ?? '');
  const h1 = htmlText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(articleHtml)?.[1] ?? '');
  const firstHeading = matter(await readFile(path.join(payloadDirectory, 'index.md'), 'utf8'))
    .content.split('\n').find((line) => /^##\s+/.test(line))?.replace(/^##\s+/, '').trim();
  const headingHtml = [...articleHtml.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((match) => htmlText(match[1]));
  const canonical = [...articleHtml.matchAll(/<link\b[^>]*>/gi)].map((match) => htmlAttributes(match[0]))
    .find((attrs) => attrs.get('rel') === 'canonical')?.get('href');
  const ogTitle = metaContent(articleHtml, 'og:title');
  const ogImage = metaContent(articleHtml, 'og:image');
  const twitterImage = metaContent(articleHtml, 'twitter:image');
  const twitterCard = metaContent(articleHtml, 'twitter:card');
  const description = metaContent(articleHtml, 'og:description');
  const ogImageAlt = metaContent(articleHtml, 'og:image:alt');
  const twitterImageAlt = metaContent(articleHtml, 'twitter:image:alt');
  if (!title.includes(candidate.seoTitle) && !title.includes(candidate.title)) throw new Error('公開記事のtitleが候補と一致しません。');
  if (h1 !== candidate.title) throw new Error('公開記事のh1が候補と一致しません。');
  if (firstHeading && !headingHtml.includes(firstHeading)) throw new Error('公開記事の本文見出しが候補と一致しません。');
  if (canonical !== candidate.publicUrl) throw new Error('公開記事のcanonical URLが候補と一致しません。');
  if (ogTitle !== title || description !== candidate.metaDescription || twitterCard !== 'summary_large_image' || !ogImage || twitterImage !== ogImage || !ogImageAlt || !twitterImageAlt) {
    throw new Error('SEO・OGP・Twitterメタデータを確認できません。');
  }
  if (!categoryHtml.includes('/blog/posts/' + candidate.slug + '/')) throw new Error('カテゴリー一覧に公開記事へのリンクがありません。');
  const verifyBlogAsset = async (value) => {
    const assetUrl = new URL(value, siteBaseUrl);
    if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'mizukioyama.github.io' || !assetUrl.pathname.startsWith('/blog/')) {
      throw new Error('公開画像がブログ公開領域外を指しています。');
    }
    await fetchPage(assetUrl.href, fetchImpl);
  };
  const coverTag = /<figure class=\"article-cover\">[\s\S]*?<img\b[^>]*>/i.exec(articleHtml)?.[0];
  const coverAttrs = coverTag ? htmlAttributes(/<img\b[^>]*>/i.exec(coverTag)?.[0] ?? '') : undefined;
  if (!coverAttrs?.get('src') || coverAttrs.get('alt') !== candidate.coverAlt) throw new Error('公開記事のアイキャッチまたはaltを確認できません。');
  await verifyBlogAsset(coverAttrs.get('src'));
  await verifyBlogAsset(ogImage);
  const record = {
    schemaVersion: 1,
    articleId: candidate.slug,
    title: candidate.title,
    publishDate: candidate.publishDate,
    publicUrl: candidate.publicUrl,
    commitSha: commitSha.toLowerCase(),
    workflowRunUrl: runUrl.href,
    verifiedAt: now.toISOString(),
    checks: {
      http: 'PASS', title: 'PASS', canonical: 'PASS', ogp: 'PASS', twitter: 'PASS',
      categoryListing: 'PASS', ogImageHttp: 'PASS',
      browserResponsiveAndConsole: 'NOT_TESTED',
    },
    analyticsReviewWindows: ['12h', '24h'],
    analyticsSource: '取得可能な実測データのみ。利用可能な情報源がなければ未取得として記録。',
  };
  await storePrivateResult(directory, record);
  return record;
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') flags.dryRun = true;
    else if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(key + ' の値を指定してください。');
      flags[key] = value;
      i += 1;
    } else positional.push(args[i]);
  }
  return { flags, positional };
}

export async function runPublicationCommand(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  const draftsDir = process.env.ARTICLE_DRAFTS_DIR ?? defaultDraftsDir;
  const contentDir = process.env.ARTICLE_CONTENT_DIR ?? defaultContentDir;
  const backupsDir = process.env.ARTICLE_BACKUPS_DIR ?? defaultBackupsDir;
  const plansDir = process.env.ARTICLE_PUBLICATION_DIR ?? defaultPlansDir;
  if (command === 'prepare') {
    if (positional.length !== 1) throw new Error('article:publish:prepare は下書きIDを1つ指定してください。');
    const result = await preparePublication({ draftsDir, contentDir, backupsDir, plansDir, draftId: positional[0] });
    console.log(JSON.stringify(result, null, 2));
    console.log('候補内容のレビューと会話上の明示承認前にmaterialize、Git、GitHub操作へ進まないでください。');
    return;
  }
  if (command === 'materialize') {
    if (positional.length !== 1) throw new Error('公開候補IDを1つ指定してください。');
    const result = await materializePublication({
      draftsDir, contentDir, plansDir, planId: positional[0], candidateSha256: flags['candidate-sha'], dryRun: flags.dryRun === true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'verify') {
    if (positional.length !== 1) throw new Error('公開候補IDを1つ指定してください。');
    const result = await verifyLivePublication({
      plansDir, planId: positional[0], commitSha: flags['commit-sha'], workflowSha: flags['workflow-sha'],
      workflowRunUrl: flags['workflow-url'], buildStatus: flags['build-status'], deployStatus: flags['deploy-status'],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log([
    '記事公開候補コマンド',
    '  npm run article:publish:prepare -- <review-draft-id>',
    '  npm run article:publish:materialize -- <plan-id> --candidate-sha <sha256> [--dry-run]',
    '  npm run article:publish:verify -- <plan-id> --commit-sha <sha> --workflow-sha <sha> --workflow-url <url> --build-status success --deploy-status success',
    '準備は非公開計画のみ作成します。Git・GitHub・公開の承認はCodexが会話上の本人承認を別に確認します。',
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPublicationCommand().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
