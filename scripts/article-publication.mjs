import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const conversationContentApprovalFile = 'conversation-content-approval.json';
const githubPublicationApprovalFile = 'github-publication-approval.json';
const approvedContentScopes = ['body', 'seoTitle', 'metaDescription', 'coverImage', 'publicationDate'];
const allowedPublicationActions = new Set(['materialize', 'stage', 'commit', 'push', 'workflow_dispatch']);

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


async function readPrivateJson(directory, fileName) {
  const file = await assertRegularFile(path.join(directory, fileName), { optional: true });
  if (!file || !inside(directory, file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

function sameStringList(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    stableJson([...left].sort()) === stableJson([...right].sort());
}


function approvalBinding(manifest) {
  const candidate = manifest.candidate;
  return {
    article: { title: candidate.title, category: candidate.category, draftId: manifest.source.draftId, slug: candidate.slug },
    candidate: {
      id: manifest.planId, sha256: candidate.candidateSha256, publicUrl: candidate.publicUrl,
      publishDate: candidate.publishDate, targetFiles: [...candidate.targetFiles].sort(),
      files: candidate.files.map(({ path: p, sha256: hash, bytes, kind }) => ({ path: p, sha256: hash, bytes, kind }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
}
function approvalEvidence(reference, now) {
  if (typeof reference !== 'string' || reference.trim().length < 8 || reference.trim().length > 240 ||
      /[\u0000-\u001f\u007f]/.test(reference)) {
    throw new Error('承認記録の参照情報を8〜240文字で指定してください。会話全文や個人情報は記録しないでください。');
  }
  return { method: 'codex-conversation-review', reference: reference.trim(), recordedAt: now.toISOString() };
}
function validApprovalEvidence(value) {
  return value?.method === 'codex-conversation-review' &&
    typeof value.reference === 'string' && value.reference.trim().length >= 8 && value.reference.trim().length <= 240 &&
    !/[\u0000-\u001f\u007f]/.test(value.reference) && typeof value.recordedAt === 'string' &&
    Number.isFinite(Date.parse(value.recordedAt));
}
async function readApprovalRecord(directory, name) {
  const file = await assertRegularFile(path.join(directory, name), { optional: true });
  if (!file) return null;
  if (!inside(directory, file)) throw new Error('承認記録が公開候補フォルダーの外を指しています。');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(name + ' をJSONとして読み取れません。既存記録を保全して手動確認してください。'); }
}
function withoutApprovalEvidence(record) {
  if (!record || typeof record !== 'object') return record;
  const copy = structuredClone(record);
  delete copy.approvalEvidence;
  return copy;
}
function sameApprovalIntent(existing, requested) {
  const left = structuredClone(existing);
  const right = structuredClone(requested);
  if (left.evidence) delete left.evidence.recordedAt;
  if (right.evidence) delete right.evidence.recordedAt;
  return stableJson(left) === stableJson(right);
}
const approvalReceiptNames = new Set([
  'content-seo-approval.json',
  'content-approval-transition.json',
  conversationContentApprovalFile,
  githubPublicationApprovalFile,
]);

async function syncReceiptDirectory(directory, syncDirectory) {
  if (syncDirectory) return syncDirectory(directory);
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Some supported filesystems do not allow fsync on a directory. Receipt bytes
    // have already been synced; the atomic directory entry may be lost on a crash,
    // in which case a retry safely creates it again.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Persist complete receipt bytes through a same-directory hard link. link(2)
 * atomically creates the destination only if it does not exist; unlike rename,
 * it never replaces an existing receipt. The temporary file is not a receipt.
 */
async function persistReceiptNoReplace(file, contents, io = {}) {
  const inputDirectory = path.dirname(file);
  const directory = await assertDirectory(inputDirectory);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('承認記録の保存先は通常の非公開ディレクトリではありません。');
  }
  if (process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0) {
    throw new Error('承認記録の保存先は所有者だけがアクセスできる権限にしてください。');
  }
  if (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid()) {
    throw new Error('承認記録の保存先が現在のユーザー所有ではありません。');
  }
  const name = path.basename(file);
  if (!approvalReceiptNames.has(name) || path.dirname(path.resolve(file)) !== directory) {
    throw new Error('承認記録のパスが許可された保存先ではありません。');
  }
  const finalPath = path.join(directory, name);
  const temporaryPath = path.join(directory, '.' + name + '.' + randomUUID() + '.tmp');
  let handle;
  let temporaryCreated = false;
  try {
    if (await realpath(inputDirectory) !== directory) throw new Error('承認記録の保存先が処理中に置き換わりました。');
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    const originalStat = await handle.stat();
    await (io.writeTemporary ?? ((fileHandle, bytes) => fileHandle.writeFile(bytes)))(
      handle, Buffer.from(contents, 'utf8'),
    );
    await (io.syncFile ?? ((fileHandle) => fileHandle.sync()))(handle);
    await handle.close();
    handle = null;

    const [currentDirectoryInfo, temporaryInfo] = await Promise.all([
      lstat(directory), lstat(temporaryPath),
    ]);
    if (currentDirectoryInfo.dev !== directoryInfo.dev || currentDirectoryInfo.ino !== directoryInfo.ino ||
        !currentDirectoryInfo.isDirectory() || currentDirectoryInfo.isSymbolicLink() ||
        await realpath(inputDirectory) !== directory) {
      throw new Error('承認記録の保存先が処理中に置き換わりました。');
    }
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() ||
        temporaryInfo.dev !== originalStat.dev || temporaryInfo.ino !== originalStat.ino) {
      throw new Error('承認記録の一時ファイルが処理中に置き換わりました。');
    }
    await io.beforeLink?.(temporaryPath, finalPath);
    try {
      await (io.linkNoReplace ?? link)(temporaryPath, finalPath);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    const [finalInfo, afterDirectoryInfo] = await Promise.all([
      lstat(finalPath), lstat(directory),
    ]);
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink() ||
        finalInfo.dev !== originalStat.dev || finalInfo.ino !== originalStat.ino ||
        afterDirectoryInfo.dev !== directoryInfo.dev || afterDirectoryInfo.ino !== directoryInfo.ino) {
      throw new Error('確定した承認記録のファイルまたは保存先を検証できません。');
    }
    await syncReceiptDirectory(directory, io.syncDirectory);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
  }
}

async function writeApprovalRecord(directory, name, record, allowLegacy = false, receiptIo = {}) {
  if (!approvalReceiptNames.has(name)) throw new Error('承認記録のファイル名が許可範囲外です。');
  const matches = (existing) => allowLegacy
    ? stableJson(withoutApprovalEvidence(existing)) === stableJson(withoutApprovalEvidence(record))
    : sameApprovalIntent(existing, record);
  const current = await readApprovalRecord(directory, name);
  if (current) {
    if (!matches(current)) throw new Error(name + ' が既に存在し、候補・承認範囲が異なるため上書きしません。');
    return false;
  }
  const created = await persistReceiptNoReplace(
    path.join(directory, name), JSON.stringify(record, null, 2) + '\n', receiptIo,
  );
  if (created) return true;
  // A concurrent writer won the no-replace link. Re-read and accept only the
  // same complete record; symlinks, corrupt JSON, and different intent fail closed.
  const raced = await readApprovalRecord(directory, name);
  if (!raced || !matches(raced)) {
    throw new Error(name + ' が並行作成され、候補・承認範囲が一致しないため停止しました。');
  }
  return false;
}
function legacyApprovalRecords(manifest, evidence) {
  const c = manifest.candidate;
  const cover = candidateFile(c, cleanImageReference(c.cover));
  if (!cover) throw new Error('候補のアイキャッチハッシュがありません。');
  return {
    partial: {
      schemaVersion: 1,
      article: { title: c.title, draftId: manifest.source.draftId, slug: c.slug, candidateId: manifest.planId, candidateSha256: c.candidateSha256 },
      partialApproval: { status: 'USER_APPROVED', approved: ['current article body', 'SEO title', 'Meta Description'], boundToCandidateSha256: c.candidateSha256 },
      approvalEvidence: evidence,
    },
    transition: {
      schemaVersion: 1, recordType: 'article-content-approval-and-status-transition',
      article: { title: c.title, category: c.category, draftId: manifest.source.draftId, slug: c.slug },
      candidate: { id: manifest.planId, sha256: c.candidateSha256, publicUrl: c.publicUrl, targetFiles: c.targetFiles, publishDate: c.publishDate, coverSha256: cover.sha256 },
      approvals: { body: 'APPROVED', seoTitle: 'APPROVED', metaDescription: 'APPROVED', coverImage: 'APPROVED', publicationDate: 'APPROVED' },
      workflowTransition: { from: 'Review', to: 'Approved' },
      approvalEvidence: evidence,
    },
  };
}
function candidateFile(candidate, filename) {
  return candidate.files.find((file) => file.path === filename);
}
async function assertDraftMatchesPlan(draft, manifest) {
  const c = manifest.candidate;
  if (draft.data.draft !== true || draft.data.title !== c.title || draft.data.category !== c.category ||
      draft.data.slug !== c.slug || sourceContentDigest(draft.data, draft.content) !== manifest.source.contentSha256 ||
      sha256(draft.brief) !== manifest.source.briefSha256 || unresolvedBriefMarker(draft.brief)) {
    throw new Error('候補作成後に元下書きまたはbriefが変更されています。');
  }
  for (const file of c.files) {
    if (file.path === 'index.md') continue;
    const asset = await readContainedAsset(draft.directory, file.path);
    if (asset.length !== file.bytes || sha256(asset) !== file.sha256) throw new Error('元下書きの画像が候補から変更されています。');
  }
}
export async function recordCandidateApproval({
  draftsDir = defaultDraftsDir, plansDir = defaultPlansDir, planId, candidateSha256: expected,
  kind, approvalReference, authorizedActions, now = new Date(), receiptIo,
}) {
  if (!['content', 'github-publication'].includes(kind)) throw new Error('承認種別はcontentまたはgithub-publicationを指定してください。');
  const { directory, manifest } = await readAndVerifyPlan({ plansDir, planId });
  const binding = approvalBinding(manifest);
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || binding.candidate.sha256 !== expected) throw new Error('候補SHA-256が保存済み候補と一致しません。');
  const draft = await readDraftSnapshot({ draftsDir, draftId: manifest.source.draftId });
  await assertDraftMatchesPlan(draft, manifest);
  const evidence = approvalEvidence(approvalReference, now);
  if (kind === 'content') {
    const requested = { schemaVersion: 1, recordType: 'candidate-content-approval', evidence, ...binding, approvedScope: approvedContentScopes };
    const existing = await readApprovalRecord(directory, conversationContentApprovalFile);
    if (existing) {
      if (!sameApprovalIntent(existing, requested)) throw new Error('内容承認記録が不一致のため上書きしません。');
      return { planId, kind, recordFile: conversationContentApprovalFile, alreadyRecorded: true };
    }
    if (draft.data.workflowStatus !== 'Review') throw new Error('内容承認記録はReview状態で作成してください。');
    const legacy = legacyApprovalRecords(manifest, evidence);
    for (const [name, record] of [['content-seo-approval.json', legacy.partial], ['content-approval-transition.json', legacy.transition]]) {
      const old = await readApprovalRecord(directory, name);
      if (old && stableJson(withoutApprovalEvidence(old)) !== stableJson(withoutApprovalEvidence(record))) {
        throw new Error(name + ' が候補と一致しません。既存記録を変更せず停止します。');
      }
    }
    await writeApprovalRecord(directory, 'content-seo-approval.json', legacy.partial, true, receiptIo);
    await writeApprovalRecord(directory, 'content-approval-transition.json', legacy.transition, true, receiptIo);
    const created = await writeApprovalRecord(directory, conversationContentApprovalFile, requested, false, receiptIo);
    return { planId, kind, recordFile: conversationContentApprovalFile, alreadyRecorded: !created };
  }
  if (!Array.isArray(authorizedActions) || !authorizedActions.length ||
      authorizedActions.some((item) => !allowedPublicationActions.has(item)) || new Set(authorizedActions).size !== authorizedActions.length) {
    throw new Error('公開承認の許可操作が空、重複、または未対応です。');
  }
  const requested = { schemaVersion: 1, recordType: 'github-publication-approval', evidence, ...binding, authorizedActions: [...authorizedActions].sort() };
  const old = await readApprovalRecord(directory, githubPublicationApprovalFile);
  if (old) {
    if (!sameApprovalIntent(old, requested)) throw new Error('GitHub公開承認記録が不一致のため上書きしません。');
    return { planId, kind, recordFile: githubPublicationApprovalFile, alreadyRecorded: true };
  }
  const created = await writeApprovalRecord(directory, githubPublicationApprovalFile, requested, false, receiptIo);
  return { planId, kind, recordFile: githubPublicationApprovalFile, alreadyRecorded: !created };
}
export async function verifyCandidateApproval({
  draftsDir = defaultDraftsDir, plansDir = defaultPlansDir, planId, candidateSha256: expected, action,
}) {
  if (!allowedPublicationActions.has(action)) throw new Error('検証対象の公開操作が許可範囲外です。');
  const { directory, manifest } = await readAndVerifyPlan({ plansDir, planId });
  const binding = approvalBinding(manifest);
  if (binding.candidate.sha256 !== expected) throw new Error('候補SHA-256が承認記録と一致しません。');
  const draft = await readDraftSnapshot({ draftsDir, draftId: manifest.source.draftId });
  if (draft.data.workflowStatus !== 'Approved') throw new Error('Approved状態ではありません。');
  await assertDraftMatchesPlan(draft, manifest);
  const content = await readApprovalRecord(directory, conversationContentApprovalFile);
  if (!content || content.schemaVersion !== 1 || content.recordType !== 'candidate-content-approval' ||
      !validApprovalEvidence(content.evidence) || stableJson(content.article) !== stableJson(binding.article) ||
      stableJson(content.candidate) !== stableJson(binding.candidate) || !sameStringList(content.approvedScope, approvedContentScopes)) {
    throw new Error('候補に結び付いた内容承認記録が欠落または不一致です。');
  }
  const legacy = legacyApprovalRecords(manifest, content.evidence);
  for (const [name, expectedRecord] of [['content-seo-approval.json', legacy.partial], ['content-approval-transition.json', legacy.transition]]) {
    const actual = await readApprovalRecord(directory, name);
    if (!actual || stableJson(withoutApprovalEvidence(actual)) !== stableJson(withoutApprovalEvidence(expectedRecord))) {
      throw new Error(name + ' が候補に結び付いていないか、不一致です。');
    }
  }
  const publication = await readApprovalRecord(directory, githubPublicationApprovalFile);
  if (!publication || publication.schemaVersion !== 1 || publication.recordType !== 'github-publication-approval' ||
      !validApprovalEvidence(publication.evidence) || stableJson(publication.article) !== stableJson(binding.article) ||
      stableJson(publication.candidate) !== stableJson(binding.candidate) || !Array.isArray(publication.authorizedActions) ||
      publication.authorizedActions.some((item) => !allowedPublicationActions.has(item)) ||
      new Set(publication.authorizedActions).size !== publication.authorizedActions.length ||
      !publication.authorizedActions.includes(action)) {
    throw new Error('GitHub公開承認記録が欠落、不一致、または操作範囲外です。');
  }
  return { planId, candidateSha256: binding.candidate.sha256, action, publicUrl: binding.candidate.publicUrl,
    publishDate: binding.candidate.publishDate, targetFiles: binding.candidate.targetFiles };
}

function gitBuffer(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8').slice(0, 500) : '';
    throw new Error('Git公開範囲の読み取りに失敗しました。' + detail);
  }
}

function gitText(args) {
  return gitBuffer(args).toString('utf8').trim();
}

async function assertFormalGitRepository() {
  const formalRoot = await realpath(repoRoot);
  const topLevel = await realpath(gitText(['rev-parse', '--show-toplevel']));
  if (topLevel !== formalRoot) throw new Error('正式ブログのGit rootではありません。');
  const gitMetadata = await lstat(path.join(formalRoot, '.git'));
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new Error('Git worktreeや置換された.gitではなく正式checkoutを使用してください。');
  }
  if (gitText(['branch', '--show-current']) !== 'main') throw new Error('Git公開範囲の照合はmain上でのみ実行できます。');
  const origin = gitText(['remote', 'get-url', 'origin']);
  if (!['https://github.com/mizukioyama/blog.git', 'git@github.com:mizukioyama/blog.git'].includes(origin)) {
    throw new Error('originが正式ブログRepositoryを指していません。');
  }
}

function nulRecords(buffer, label) {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) throw new Error(label + ' のNUL区切り出力が不完全です。');
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      values.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return values;
}

function decodeGitPath(buffer) {
  const value = buffer.toString('utf8');
  if (!value || !Buffer.from(value, 'utf8').equals(buffer) || value.includes('\\') ||
      value.includes(String.fromCharCode(0)) || value.startsWith('/') || path.posix.normalize(value) !== value ||
      value.split('/').some((part) => !part || part === '.' || part === '..') ||
      value.normalize('NFC') !== value) {
    throw new Error('Gitが返したファイル名を安全な正規UTF-8パスとして扱えません。');
  }
  return value;
}

function parseGitNameStatus(buffer, label) {
  const records = nulRecords(buffer, label);
  const changes = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++].toString('ascii');
    if (!/^[A-Z](?:[0-9]{1,3})?$/.test(status)) throw new Error(label + ' の変更statusを解析できません。');
    const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    if (index + count > records.length) throw new Error(label + ' のrename/copyパスが不足しています。');
    const paths = records.slice(index, index + count).map(decodeGitPath);
    index += count;
    changes.push({ status, paths });
  }
  return changes;
}

function parseGitIndexEntries(buffer) {
  return nulRecords(buffer, 'git ls-files --stage').map((record) => {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Git index entryの区切りを解析できません。');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3 || !/^(?:100644|100755|120000|160000)$/.test(metadata[0]) ||
        !/^[a-f0-9]{40,64}$/i.test(metadata[1]) || !/^[0-3]$/.test(metadata[2])) {
      throw new Error('Git index entryのmode・object・stageが不正です。');
    }
    return { mode: metadata[0], oid: metadata[1], stage: Number(metadata[2]), path: decodeGitPath(record.subarray(tab + 1)) };
  });
}

function parseGitTreeEntries(buffer) {
  return nulRecords(buffer, 'git ls-tree').map((record) => {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Git commit tree entryの区切りを解析できません。');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3 || !/^(?:100644|100755|120000|160000)$/.test(metadata[0]) ||
        !/^(?:blob|tree|commit)$/.test(metadata[1]) || !/^[a-f0-9]{40,64}$/i.test(metadata[2])) {
      throw new Error('Git commit tree entryのmode・type・objectが不正です。');
    }
    return { mode: metadata[0], type: metadata[1], oid: metadata[2], path: decodeGitPath(record.subarray(tab + 1)) };
  });
}

function deriveCandidateGitFiles(manifest) {
  const candidate = manifest.candidate;
  const expected = new Map();
  const caseKeys = new Set();
  for (const file of candidate.files) {
    const relative = path.posix.join(candidate.targetDirectory, file.path);
    const gitPath = 'src/content/blog/' + relative;
    if (!safeRelativePath(gitPath) || gitPath.normalize('NFC') !== gitPath) {
      throw new Error('公開候補から導出したGitパスが正規化されていません。');
    }
    const caseKey = gitPath.toLocaleLowerCase('en-US');
    if (caseKeys.has(caseKey) || expected.has(gitPath)) throw new Error('公開候補に大小文字を区別しないパス重複があります。');
    caseKeys.add(caseKey);
    expected.set(gitPath, file);
  }
  const derivedTargetFiles = [...expected.keys()].map((item) => item.slice('src/content/blog/'.length)).sort();
  if (!sameStringList(candidate.targetFiles, derivedTargetFiles)) {
    throw new Error('候補allowlistがpayloadから導出したファイル一覧と一致しません。');
  }
  return expected;
}

function assertCandidateAddedChanges(changes, expected, phase) {
  const expectedCaseKeys = new Map([...expected.keys()].map((item) => [item.toLocaleLowerCase('en-US'), item]));
  const found = new Set();
  for (const change of changes) {
    if (change.paths.length !== 1) throw new Error(phase + ' にrename/copyが含まれています。');
    const actual = change.paths[0];
    const canonical = expectedCaseKeys.get(actual.toLocaleLowerCase('en-US'));
    if (canonical && canonical !== actual) throw new Error(phase + ' のパス大小文字またはUnicode正規化が候補と異なります。');
    if (!expected.has(actual)) throw new Error(phase + ' に候補allowlist外のファイルがあります: ' + actual);
    if (found.has(actual)) throw new Error(phase + ' に同じパスが重複しています: ' + actual);
    found.add(actual);
    if (change.status !== 'A') throw new Error(phase + ' の変更種別が新規追加Aではありません: ' + change.status + ' ' + actual);
  }
  for (const expectedPath of expected.keys()) {
    if (!found.has(expectedPath)) throw new Error(phase + ' から候補ファイルが欠落しています: ' + expectedPath);
  }
  if (changes.length !== expected.size) throw new Error(phase + ' の変更件数が候補ファイル数と一致しません。');
}

function verifyCandidateBlob(pathname, entry, expectedFile, phase) {
  if (entry.mode !== '100644' || (entry.type && entry.type !== 'blob') || entry.stage !== undefined && entry.stage !== 0) {
    throw new Error(phase + ' の候補ファイルが通常の非実行ファイルではありません: ' + pathname);
  }
  const bytes = gitBuffer(['cat-file', 'blob', entry.oid]);
  if (bytes.length !== expectedFile.bytes || sha256(bytes) !== expectedFile.sha256) {
    throw new Error(phase + ' の候補ファイルSHA-256が保存payloadと一致しません: ' + pathname);
  }
}

async function verifyCandidateGitIndex(expected) {
  const changes = parseGitNameStatus(
    gitBuffer(['diff', '--cached', '--name-status', '-z', '--find-renames', '--no-ext-diff']),
    'git diff --cached',
  );
  assertCandidateAddedChanges(changes, expected, 'Git index');
  if (gitBuffer(['ls-files', '--unmerged', '-z']).length) throw new Error('Git indexに未解決merge entryがあります。');
  const entries = parseGitIndexEntries(gitBuffer(['ls-files', '--stage', '-z']));
  const summaries = [];
  for (const [pathname, file] of expected) {
    const matches = entries.filter((entry) => entry.path === pathname);
    if (matches.length !== 1 || matches[0].stage !== 0) throw new Error('Git indexの候補pathが一意なstage 0 entryではありません: ' + pathname);
    verifyCandidateBlob(pathname, matches[0], file, 'Git index');
    summaries.push({ path: pathname, status: 'A', sha256: file.sha256, bytes: file.bytes, mode: matches[0].mode });
  }
  return summaries;
}

async function verifyCandidateCommit(expected) {
  const head = gitText(['rev-parse', '--verify', 'HEAD']);
  if (!validCommit.test(head)) throw new Error('HEADが検証可能なcommit SHAではありません。');
  const parents = gitText(['rev-list', '--parents', '-n', '1', head]).split(/\s+/).filter(Boolean);
  if (parents.length !== 2) throw new Error('公開commitは単一の親commitを持つ必要があります。');
  const originMain = gitText(['rev-parse', '--verify', 'refs/remotes/origin/main']);
  if (parents[1] !== originMain) throw new Error('公開commitの親が確認済みorigin/mainと一致しません。');
  const changes = parseGitNameStatus(
    gitBuffer(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames', parents[1], head]),
    'commit diff-tree',
  );
  assertCandidateAddedChanges(changes, expected, 'commit tree');
  const tree = parseGitTreeEntries(gitBuffer(['ls-tree', '-r', '-z', '--full-tree', head]));
  const summaries = [];
  for (const [pathname, file] of expected) {
    const matches = tree.filter((entry) => entry.path === pathname);
    if (matches.length !== 1) throw new Error('commit treeの候補pathが一意ではありません: ' + pathname);
    verifyCandidateBlob(pathname, matches[0], file, 'commit tree');
    summaries.push({ path: pathname, status: 'A', sha256: file.sha256, bytes: file.bytes, mode: matches[0].mode });
  }
  const remainingStaged = gitBuffer(['diff', '--cached', '--name-status', '-z', '--find-renames']);
  if (parseGitNameStatus(remainingStaged, 'post-commit index').length) {
    throw new Error('commit後に別のステージ済み変更が残っています。');
  }
  return { commitSha: head, parentSha: parents[1], originMainSha: originMain, files: summaries };
}

/**
 * Read-only publication boundary check. CLI callers cannot provide a repository
 * root or allowlist; paths and hashes are derived from the verified private plan.
 */
export async function verifyCandidateGitScope({
  draftsDir = defaultDraftsDir, plansDir = defaultPlansDir, planId, candidateSha256: expected, phase,
}) {
  if (!['index', 'commit'].includes(phase)) throw new Error('Git照合phaseはindexまたはcommitを指定してください。');
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('保存済み候補のSHA-256を指定してください。');
  const { manifest } = await readAndVerifyPlan({ plansDir, planId });
  if (manifest.candidate.candidateSha256 !== expected) throw new Error('指定candidate SHA-256がplanと一致しません。');
  await verifyCandidateApproval({ draftsDir, plansDir, planId, candidateSha256: expected, action: 'stage' });
  await verifyCandidateApproval({ draftsDir, plansDir, planId, candidateSha256: expected, action: 'commit' });
  await assertFormalGitRepository();
  const expectedFiles = deriveCandidateGitFiles(manifest);
  if (phase === 'index') {
    const files = await verifyCandidateGitIndex(expectedFiles);
    return { planId, candidateSha256: expected, phase, readOnly: true, files };
  }
  const result = await verifyCandidateCommit(expectedFiles);
  return { planId, candidateSha256: expected, phase, readOnly: true, ...result };
}

export async function isVerifiedApprovedPublicationPair({
  draftFile,
  publicFile,
  draftsDir = defaultDraftsDir,
  contentDir = defaultContentDir,
  plansDir = defaultPlansDir,
}) {
  try {
    const draftsRoot = await assertDirectory(draftsDir);
    const draftReal = await assertRegularFile(draftFile);
    if (!inside(draftsRoot, draftReal)) return false;
    const relativeDraft = path.relative(draftsRoot, draftReal).split(path.sep);
    if (relativeDraft.length !== 2 || relativeDraft[1] !== 'index.md') return false;
    const draftId = relativeDraft[0];
    assertValidId(draftId, '下書きID');
    const draft = await readDraftSnapshot({ draftsDir, draftId });
    if (draft.indexFile !== draftReal || draft.data.workflowStatus !== 'Approved' || draft.data.draft !== true) return false;

    const contentRoot = await assertDirectory(contentDir);
    const publicReal = await assertRegularFile(publicFile);
    if (!inside(contentRoot, publicReal)) return false;
    const plansRoot = await assertDirectory(plansDir);
    const matchingRecords = [];
    for (const entry of await readdir(plansRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId.test(entry.name)) continue;
      const directory = await assertDirectory(path.join(plansRoot, entry.name));
      if (!inside(plansRoot, directory)) continue;
      const transition = await readPrivateJson(directory, 'content-approval-transition.json');
      if (transition?.article?.draftId === draftId && transition.article.slug === draft.data.slug) {
        matchingRecords.push({ folderName: entry.name, directory, transition });
      }
    }
    if (matchingRecords.length !== 1) return false;

    const { folderName, directory, transition } = matchingRecords[0];
    const planId = transition.candidate?.id;
    if (typeof planId !== 'string' || planId !== folderName || !validId.test(planId)) return false;
    const verified = await readAndVerifyPlan({ plansDir, planId });
    if (verified.directory !== directory) return false;
    const { manifest } = verified;
    const candidate = manifest.candidate;
    const candidateSha = candidate.candidateSha256;
    const coverPath = cleanImageReference(candidate.cover);
    const coverFile = candidate.files.find((file) => file.path === coverPath);
    if (!coverFile) return false;

    const partial = await readPrivateJson(directory, 'content-seo-approval.json');
    if (!partial || partial.schemaVersion !== 1 ||
        partial.article?.title !== candidate.title ||
        partial.article?.draftId !== draftId ||
        partial.article?.slug !== candidate.slug ||
        partial.article?.candidateId !== planId ||
        partial.article?.candidateSha256 !== candidateSha ||
        partial.partialApproval?.status !== 'USER_APPROVED' ||
        partial.partialApproval?.boundToCandidateSha256 !== candidateSha ||
        !Array.isArray(partial.partialApproval.approved) ||
        !['current article body', 'SEO title', 'Meta Description'].every((item) => partial.partialApproval.approved.includes(item))) return false;

    const approvedArticle = transition.article;
    const approvedCandidate = transition.candidate;
    const approvals = transition.approvals;
    if (transition.schemaVersion !== 1 ||
        transition.recordType !== 'article-content-approval-and-status-transition' ||
        approvedArticle.title !== candidate.title ||
        approvedArticle.category !== candidate.category ||
        approvedArticle.draftId !== draftId ||
        approvedArticle.slug !== candidate.slug ||
        approvedCandidate.id !== planId ||
        approvedCandidate.sha256 !== candidateSha ||
        approvedCandidate.publicUrl !== candidate.publicUrl ||
        approvedCandidate.publishDate !== candidate.publishDate ||
        !sameStringList(approvedCandidate.targetFiles, candidate.targetFiles) ||
        approvedCandidate.coverSha256 !== coverFile.sha256 ||
        transition.workflowTransition?.from !== 'Review' ||
        transition.workflowTransition?.to !== 'Approved' ||
        approvals?.body !== 'APPROVED' ||
        approvals?.seoTitle !== 'APPROVED' ||
        approvals?.metaDescription !== 'APPROVED' ||
        approvals?.coverImage !== 'APPROVED' ||
        approvals?.publicationDate !== 'APPROVED') return false;

    if (manifest.source.draftId !== draftId ||
        manifest.source.slug !== draft.data.slug ||
        draft.data.slug !== candidate.slug ||
        draft.data.title !== candidate.title ||
        draft.data.category !== candidate.category ||
        sourceContentDigest(draft.data, draft.content) !== manifest.source.contentSha256 ||
        sha256(draft.brief) !== manifest.source.briefSha256) return false;

    for (const file of candidate.files) {
      if (file.path === 'index.md') continue;
      const sourceAsset = await readContainedAsset(draft.directory, file.path);
      if (sourceAsset.length !== file.bytes || sha256(sourceAsset) !== file.sha256) return false;
    }

    const target = path.resolve(contentRoot, ...candidate.targetDirectory.split('/'));
    const targetReal = await assertDirectory(target);
    if (!inside(contentRoot, targetReal)) return false;
    if (await assertRegularFile(path.join(targetReal, 'index.md')) !== publicReal) return false;
    if (await assertRegularFile(path.join(targetReal, privateMarker), { optional: true })) return false;
    return await verifyTargetFiles(targetReal, candidate.files);
  } catch {
    return false;
  }
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
  if (!targetInfo || markerPresent) {
    await verifyCandidateApproval({ draftsDir, plansDir, planId, candidateSha256: candidate.candidateSha256, action: 'materialize' });
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
  if (command === 'record-approval') {
    if (positional.length !== 1) throw new Error('公開候補IDを1つ指定してください。');
    const actions = flags['authorized-actions']?.split(',').map((value) => value.trim()).filter(Boolean);
    const result = await recordCandidateApproval({
      draftsDir, plansDir, planId: positional[0], candidateSha256: flags['candidate-sha'],
      kind: flags.kind, approvalReference: flags['approval-reference'], authorizedActions: actions,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log('会話上の確認を追跡する記録です。暗号学的な本人認証ではありません。');
    return;
  }
  if (command === 'check-approval') {
    if (positional.length !== 1) throw new Error('公開候補IDを1つ指定してください。');
    const result = await verifyCandidateApproval({
      draftsDir, plansDir, planId: positional[0], candidateSha256: flags['candidate-sha'], action: flags.action,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'check-git-scope') {
    if (positional.length !== 1) throw new Error('公開候補IDを1つ指定してください。');
    if (Object.keys(flags).some((key) => !['candidate-sha', 'phase'].includes(key))) {
      throw new Error('Git scope gateは候補からallowlistを導出します。任意のallowlist等は指定できません。');
    }
    const result = await verifyCandidateGitScope({
      draftsDir, plansDir, planId: positional[0],
      candidateSha256: flags['candidate-sha'], phase: flags.phase,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log('読み取り専用照合です。Git index、commit、remoteは変更しません。');
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
    '  npm run article:publish:record-approval -- <plan-id> --kind content|github-publication --candidate-sha <sha256> --approval-reference <reference>',
    '  npm run article:publish:check-approval -- <plan-id> --candidate-sha <sha256> --action <action>',
    '  npm run article:publish:check-git-scope -- <plan-id> --candidate-sha <sha256> --phase index|commit',
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
