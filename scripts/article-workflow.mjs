import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import matter from 'gray-matter';
import { collectArticleFiles, validateArticleData } from './article-validation.mjs';
import { isVerifiedApprovedPublicationPair } from './article-publication.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultDraftsDir = path.join(repoRoot, '.private-drafts');
const defaultBackupsDir = path.join(repoRoot, '.private-draft-backups');
const defaultContentDir = path.join(repoRoot, 'src/content/blog');
const defaultPlansDir = path.join(repoRoot, '.private-publication');
const categoryNames = new Set(['Art', 'Exhibition', 'Creative']);
const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statusTransitions = {
  Draft: new Set(['Review']),
  Review: new Set(['Draft', 'Approved']),
  Approved: new Set(['Review']),
};

function localDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function displayDate(value) {
  if (value === undefined || value === null || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString().slice(0, 10);
}

function timeSlug(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return 'draft-' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function assertSafeId(value, label = 'draft ID') {
  if (typeof value !== 'string' || !validSlug.test(value)) {
    throw new Error(label + ' は小文字英数字とハイフンで指定してください。');
  }
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}


async function getDraftDirectory({ draftsDir, draftId }) {
  assertSafeId(draftId);
  const root = path.resolve(draftsDir);
  const directory = path.resolve(root, draftId);
  if (!isWithinDirectory(root, directory)) throw new Error('下書きの保存先が許可フォルダーの外です。');
  const [rootInfo, rootReal, directoryInfo] = await Promise.all([lstat(root), realpath(root), lstat(directory)]);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('下書き保存先は通常のローカルフォルダーを指定してください。');
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('下書きフォルダーが安全な通常ディレクトリではありません。');
  const directoryReal = await realpath(directory);
  if (!isWithinDirectory(rootReal, directoryReal)) throw new Error('下書きフォルダーが許可フォルダーの外を指しています。');
  return directoryReal;
}

async function assertRegularTarget(file, allowMissing = false) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('保存先が通常ファイルではありません: ' + file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return false;
    if (error.code === 'ENOENT') throw new Error('保存先ファイルがありません: ' + file);
    throw error;
  }
}

async function getDraftPaths({ draftsDir, draftId }) {
  const directory = await getDraftDirectory({ draftsDir, draftId });
  const file = path.join(directory, 'index.md');
  await assertRegularTarget(file);
  const fileReal = await realpath(file);
  if (!isWithinDirectory(directory, fileReal)) throw new Error('下書き index.md が下書きフォルダーの外を指しています。');
  return { directory, file: fileReal };
}

async function prepareAtomicWrite(file, contents) {
  await assertRegularTarget(file, true);
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAtomicWithRename(file, contents, renameFile = rename) {
  const temporary = await prepareAtomicWrite(file, contents);
  try {
    await renameFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAtomic(file, contents) {
  await writeAtomicWithRename(file, contents, rename);
}

async function writeDurableNewFile(file, contents = '') {
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}

async function hasRegularMarker(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('復旧マーカーが通常ファイルではありません: ' + file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function restoreSnapshotFile(directory, recoveryDirectory, name, renameFile = rename) {
  const snapshot = path.join(recoveryDirectory, name);
  await assertRegularTarget(snapshot);
  const contents = await readFile(snapshot);
  await writeAtomicWithRename(path.join(directory, name), contents, renameFile);
}

async function recoverPendingDraftSaves(directory, renameFile = rename) {
  const entries = await readdir(directory, { withFileTypes: true });
  let recovered = 0;
  for (const entry of entries) {
    if (!/^\.article-save-recovery-[0-9a-f-]{36}$/.test(entry.name)) continue;
    const recoveryDirectory = path.join(directory, entry.name);
    const info = await lstat(recoveryDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('復旧フォルダーが安全な通常ディレクトリではありません: ' + recoveryDirectory);
    }
    const recoveryReal = await realpath(recoveryDirectory);
    if (!isWithinDirectory(directory, recoveryReal)) throw new Error('復旧フォルダーが下書きフォルダーの外を指しています。');
    const ready = await hasRegularMarker(path.join(recoveryDirectory, 'READY'));
    if (!ready) {
      await rm(recoveryDirectory, { recursive: true, force: true });
      continue;
    }
    const committed = await hasRegularMarker(path.join(recoveryDirectory, 'COMMITTED'));
    if (committed) {
      await rm(recoveryDirectory, { recursive: true, force: true });
      continue;
    }
    try {
      await restoreSnapshotFile(directory, recoveryDirectory, 'index.md', renameFile);
      await restoreSnapshotFile(directory, recoveryDirectory, 'brief.md', renameFile);
      await rm(recoveryDirectory, { recursive: true, force: true });
      recovered += 1;
    } catch (error) {
      throw new Error(
        '中断した記事保存の自動復旧に失敗しました。元データは復旧フォルダーに保全しています: ' +
        recoveryDirectory + '。再試行は npm run article:recover -- <draft-id> で行えます。原因: ' + error.message,
        { cause: error },
      );
    }
  }
  return recovered;
}

export async function recoverInterruptedDraftSave({ draftsDir = defaultDraftsDir, draftId, renameFile = rename }) {
  const directory = await getDraftDirectory({ draftsDir, draftId });
  const recovered = await recoverPendingDraftSaves(directory, renameFile);
  return { draftId, recovered };
}

async function saveDraftPair({ directory, articleContents, briefContents, renameFile = rename }) {
  const articlePath = path.join(directory, 'index.md');
  const briefPath = path.join(directory, 'brief.md');
  await assertRegularTarget(articlePath);
  await assertRegularTarget(briefPath);
  const [originalArticle, originalBrief] = await Promise.all([readFile(articlePath), readFile(briefPath)]);
  const recoveryDirectory = path.join(directory, '.article-save-recovery-' + randomUUID());
  let articleTemporary;
  let briefTemporary;
  let ready = false;
  let articleReplaced = false;
  let briefReplaced = false;
  try {
    await mkdir(recoveryDirectory, { mode: 0o700 });
    await writeDurableNewFile(path.join(recoveryDirectory, 'index.md'), originalArticle);
    await writeDurableNewFile(path.join(recoveryDirectory, 'brief.md'), originalBrief);
    await writeDurableNewFile(path.join(recoveryDirectory, 'READY'));
    ready = true;

    articleTemporary = await prepareAtomicWrite(articlePath, articleContents);
    briefTemporary = await prepareAtomicWrite(briefPath, briefContents);
    await renameFile(articleTemporary, articlePath);
    articleTemporary = undefined;
    articleReplaced = true;
    await renameFile(briefTemporary, briefPath);
    briefTemporary = undefined;
    briefReplaced = true;
    await writeDurableNewFile(path.join(recoveryDirectory, 'COMMITTED'));
  } catch (error) {
    if (articleTemporary) await rm(articleTemporary, { force: true }).catch(() => {});
    if (briefTemporary) await rm(briefTemporary, { force: true }).catch(() => {});
    const changed = articleReplaced || briefReplaced;
    const restoreErrors = [];
    if (ready && changed) {
      for (const name of ['index.md', 'brief.md']) {
        try {
          await restoreSnapshotFile(directory, recoveryDirectory, name, renameFile);
        } catch (restoreError) {
          restoreErrors.push(name + ': ' + restoreError.message);
        }
      }
    }
    if (restoreErrors.length) {
      throw new Error(
        '記事保存後の復元にも失敗しました。元データは復旧フォルダーに保全しています: ' +
        recoveryDirectory + '。npm run article:recover -- <draft-id> で復旧を再試行してください。' +
        ' 保存エラー: ' + error.message + '。復元エラー: ' + restoreErrors.join(' / '),
        { cause: error },
      );
    }
    try {
      await rm(recoveryDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        '記事保存に失敗し、元データは' + (changed ? '復元済み' : '未変更') +
        'ですが復旧フォルダーを保持しています: ' + recoveryDirectory +
        '。npm run article:recover -- <draft-id> で整理できます。原因: ' + cleanupError.message,
        { cause: error },
      );
    }
    throw new Error(
      '記事とブリーフの保存に失敗しました。' +
      (changed ? '元のindex.mdとbrief.mdを復元しました。' : '既存データは変更されていません。') +
      ' 原因: ' + error.message,
      { cause: error },
    );
  } finally {
    if (articleTemporary) await rm(articleTemporary, { force: true }).catch(() => {});
    if (briefTemporary) await rm(briefTemporary, { force: true }).catch(() => {});
  }

  let recoveryCleanupPending;
  try {
    await rm(recoveryDirectory, { recursive: true, force: true });
  } catch {
    recoveryCleanupPending = recoveryDirectory;
  }
  return { recoveryCleanupPending };
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('バックアップ対象にシンボリックリンクが含まれています: ' + entry.name);
    if (info.isDirectory()) await assertNoSymlinks(file);
    else if (!info.isFile()) throw new Error('バックアップ対象に通常ファイル以外が含まれています: ' + entry.name);
  }
}

async function copyDirectoryAtomic(source, destination) {
  try {
    await lstat(destination);
    throw new Error('コピー先に既存ファイルがあります。上書きしません。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + randomUUID() + '.tmp');
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function backupDraftId(backupId) {
  const match = /^(\d{8}T\d{6}Z)--([a-z0-9]+(?:-[a-z0-9]+)*)--([a-f0-9]{8})$/.exec(backupId ?? '');
  if (!match) throw new Error('バックアップIDの形式が正しくありません。');
  return match[2];
}

export async function createDraft({ draftsDir = defaultDraftsDir, topic, notes = '', category = 'Creative', now = new Date() }) {
  const cleanTopic = String(topic ?? '').trim();
  if (!cleanTopic) throw new Error('記事テーマを指定してください。');
  if (!categoryNames.has(category)) throw new Error('category は Art / Exhibition / Creative のいずれかを指定してください。');
  const slug = timeSlug(now);
  const root = path.resolve(draftsDir);
  const directory = path.join(root, slug);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('下書き保存先は通常のローカルフォルダーを指定してください。');
  try {
    await lstat(directory);
    throw new Error('同じslugの下書きが存在します。もう一度実行してください。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const data = {
    title: cleanTopic.slice(0, 100),
    slug,
    description: 'この記事で扱うテーマ、背景、制作過程などを紹介します。公開前に内容に合わせて書き換えてください。',
    pubDate: localDate(now),
    category,
    tags: [],
    draft: true,
    workflowStatus: 'Draft',
  };
  const body = '# 制作メモ\n\n本文はまだ作成されていません。brief.mdを確認し、確認できた事実と本人から提供された体験だけを使って記事を作成してください。\n';
  const articleSource = matter.stringify(body, data);
  const brief = '# 記事制作ブリーフ\n\n## テーマ\n\n' + cleanTopic + '\n\n## メモ\n\n' +
    (String(notes).trim() || '未入力') + '\n\n## 参考資料・確認事項\n\n必要に応じてURL、資料名、確認した事実を追記してください。未確認の事実や本人の体験を推測で補わないでください。\n\n## アイキャッチ案\n\nコンセプト、掲載コピー、サイズ（1200 × 630 px）、alt、ファイル名を記録してください。生成していない画像を生成済みと記録しないでください。\n';
  const temporary = path.join(root, '.new-' + randomUUID());
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(path.join(temporary, 'brief.md'), brief, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(temporary, 'index.md'), articleSource, { flag: 'wx', mode: 0o600 });
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw new Error('同じslugの下書きが存在します。もう一度実行してください。');
    throw error;
  }
  const articlePath = path.join(directory, 'index.md');
  const briefPath = path.join(directory, 'brief.md');
  return { slug, draftId: slug, directory, articlePath, briefPath };
}

export async function loadDraft({ draftsDir = defaultDraftsDir, slug }) {
  const directory = await getDraftDirectory({ draftsDir, draftId: slug });
  await recoverPendingDraftSaves(directory);
  const { file } = await getDraftPaths({ draftsDir, draftId: slug });
  const source = await readFile(file, 'utf8');
  const parsed = matter(source);
  return { draftId: slug, directory, file, source, parsed, data: parsed.data, content: parsed.content };
}

async function knownSlugs(contentDir, draftsDir, currentFile, verifiedPublicFile) {
  const slugs = new Set();
  const verifiedPublicReal = verifiedPublicFile ? await realpath(verifiedPublicFile) : null;
  for (const file of (await collectArticleFiles(contentDir)).filter((item) => path.basename(item) === 'index.md')) {
    if (verifiedPublicReal && await realpath(file) === verifiedPublicReal) continue;
    const parsed = matter(await readFile(file, 'utf8'));
    if (typeof parsed.data.slug === 'string') slugs.add(parsed.data.slug);
  }
  for (const file of (await collectArticleFiles(draftsDir)).filter((item) => path.basename(item) === 'index.md')) {
    if (await realpath(file) === currentFile) continue;
    const parsed = matter(await readFile(file, 'utf8'));
    if (typeof parsed.data.slug === 'string') slugs.add(parsed.data.slug);
  }
  return slugs;
}

async function verifiedPublicFileForDraft({ draft, draftsDir, contentDir, plansDir }) {
  if (draft.data.workflowStatus !== 'Approved' || draft.data.draft !== true || typeof draft.data.slug !== 'string') {
    return null;
  }
  const verifiedFiles = [];
  for (const file of (await collectArticleFiles(contentDir)).filter((item) => path.basename(item) === 'index.md')) {
    const published = matter(await readFile(file, 'utf8'));
    if (published.data.slug !== draft.data.slug || published.data.draft !== false) continue;
    if (await isVerifiedApprovedPublicationPair({
      draftFile: draft.file,
      publicFile: file,
      draftsDir,
      contentDir,
      plansDir,
    })) {
      verifiedFiles.push(await realpath(file));
    }
  }
  return verifiedFiles.length === 1 ? verifiedFiles[0] : null;
}

export async function validateDraft({
  draftsDir = defaultDraftsDir,
  contentDir = defaultContentDir,
  plansDir = defaultPlansDir,
  slug,
  workflowStatus,
  allowVerifiedPublicationPair = false,
}) {
  const draft = await loadDraft({ draftsDir, slug });
  const data = workflowStatus ? { ...draft.data, workflowStatus } : draft.data;
  const verifiedPublicFile = allowVerifiedPublicationPair &&
    draft.data.workflowStatus === 'Approved' &&
    draft.data.draft === true &&
    data.workflowStatus === 'Approved'
    ? await verifiedPublicFileForDraft({ draft, draftsDir, contentDir, plansDir })
    : null;
  const known = await knownSlugs(contentDir, draftsDir, draft.file, verifiedPublicFile);
  const issues = await validateArticleData({
    data,
    content: draft.content,
    directory: path.dirname(draft.file),
    privateDraft: true,
    knownSlugs: known,
  });
  return { ...draft, data, issues };
}

export async function saveDraftArticle({ draftsDir = defaultDraftsDir, contentDir = defaultContentDir, draftId, data, content, brief, renameFile = rename }) {
  const draft = await loadDraft({ draftsDir, slug: draftId });
  if (draft.data.workflowStatus !== 'Draft' || draft.data.draft !== true) {
    throw new Error('Review中の記事を編集する前に、状態をDraftへ戻してください。');
  }
  if (!data || typeof data !== 'object' || typeof content !== 'string') throw new Error('data と content を含む記事JSONが必要です。');
  if (brief !== undefined && typeof brief !== 'string') throw new Error('brief は文字列で指定してください。');
  const nextData = { ...draft.data, ...data, draft: true, workflowStatus: 'Draft' };
  const known = await knownSlugs(contentDir, draftsDir, draft.file);
  const issues = await validateArticleData({ data: nextData, content, directory: draft.directory, privateDraft: true, knownSlugs: known });
  if (issues.length) throw new Error('保存前検証に失敗しました:\n- ' + issues.join('\n- '));
  const articleContents = matter.stringify(content, nextData);
  let recoveryCleanupPending;
  if (brief !== undefined) {
    ({ recoveryCleanupPending } = await saveDraftPair({
      directory: draft.directory,
      articleContents,
      briefContents: brief,
      renameFile,
    }));
  } else {
    await writeAtomic(draft.file, articleContents);
  }
  return { draftId, slug: nextData.slug, file: draft.file, data: nextData, recoveryCleanupPending };
}

export async function storeGeneratedAsset({ draftsDir = defaultDraftsDir, draftId, sourcePath, fileName }) {
  const draft = await loadDraft({ draftsDir, slug: draftId });
  if (draft.data.workflowStatus !== 'Draft') throw new Error('画像を追加するには下書き状態をDraftにしてください。');
  if (typeof fileName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,60}\.(?:png|jpe?g|webp|avif)$/i.test(fileName)) {
    throw new Error('画像ファイル名は安全な英数字名とPNG/JPG/WebP/AVIF拡張子で指定してください。');
  }
  const source = path.resolve(String(sourcePath ?? ''));
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('生成画像の入力元は通常ファイルを指定してください。');
  const sourceReal = await realpath(source);
  const tempRoots = await Promise.all([os.tmpdir(), '/private/tmp'].map((item) => realpath(item).catch(() => null)));
  if (!tempRoots.filter(Boolean).some((root) => isWithinDirectory(root, sourceReal))) {
    throw new Error('生成画像の入力元は一時フォルダー内に限ります。');
  }
  if (sourceInfo.size < 1 || sourceInfo.size > 20 * 1024 * 1024) throw new Error('生成画像は20 MB以下にしてください。');
  const target = path.join(draft.directory, fileName);
  try {
    await lstat(target);
    throw new Error('同名の画像がすでにあります。既存ファイルは上書きしません。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeAtomic(target, await readFile(sourceReal));
  return { draftId, fileName, relativePath: './' + fileName, file: target };
}

export async function backupDraft({ draftsDir = defaultDraftsDir, backupsDir = defaultBackupsDir, draftId, now = new Date() }) {
  const draft = await loadDraft({ draftsDir, slug: draftId });
  await assertNoSymlinks(draft.directory);
  const draftsRoot = path.resolve(draftsDir);
  const backupRoot = path.resolve(backupsDir);
  if (draftsRoot === backupRoot || isWithinDirectory(draftsRoot, backupRoot) || isWithinDirectory(backupRoot, draftsRoot)) {
    throw new Error('バックアップ先と下書きフォルダーは分離してください。');
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupInfo = await lstat(backupRoot);
  if (!backupInfo.isDirectory() || backupInfo.isSymbolicLink()) throw new Error('バックアップ先は通常のローカルフォルダーを指定してください。');
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupId = timestamp + '--' + draftId + '--' + randomUUID().slice(0, 8);
  const destination = path.join(backupRoot, backupId);
  if (!isWithinDirectory(backupRoot, destination)) throw new Error('バックアップ先が許可フォルダーの外です。');
  await copyDirectoryAtomic(draft.directory, destination);
  return { backupId, path: destination, draftId };
}

export async function restoreDraft({ draftsDir = defaultDraftsDir, backupsDir = defaultBackupsDir, backupId, restoreAs }) {
  const originalId = backupDraftId(backupId);
  const backupRoot = path.resolve(backupsDir);
  const source = path.resolve(backupRoot, backupId);
  if (!isWithinDirectory(backupRoot, source)) throw new Error('バックアップが許可フォルダーの外です。');
  const [backupRootInfo, backupRootReal, sourceInfo] = await Promise.all([lstat(backupRoot), realpath(backupRoot), lstat(source)]);
  if (!backupRootInfo.isDirectory() || backupRootInfo.isSymbolicLink()) throw new Error('バックアップ保存先は通常のローカルフォルダーではありません。');
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('バックアップは通常のフォルダーを指定してください。');
  const sourceReal = await realpath(source);
  if (!isWithinDirectory(backupRootReal, sourceReal)) throw new Error('バックアップフォルダーが許可範囲外を指しています。');
  await assertNoSymlinks(sourceReal);
  const draftId = restoreAs ?? originalId;
  assertSafeId(draftId);
  const draftsRoot = path.resolve(draftsDir);
  await mkdir(draftsRoot, { recursive: true, mode: 0o700 });
  const draftsRootInfo = await lstat(draftsRoot);
  if (!draftsRootInfo.isDirectory() || draftsRootInfo.isSymbolicLink()) throw new Error('復元先は通常のローカルフォルダーを指定してください。');
  const destination = path.join(draftsRoot, draftId);
  try {
    await lstat(destination);
    throw new Error('復元先に同じIDが存在します。既存下書きは上書きしません。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await copyDirectoryAtomic(sourceReal, destination);
  return { draftId, directory: destination, backupId };
}

export async function updateDraftStatus({ draftsDir = defaultDraftsDir, contentDir = defaultContentDir, slug, workflowStatus, confirmedByUser = false, now = new Date() }) {
  if (workflowStatus === 'Approved' && confirmedByUser !== true) {
    throw new Error('Approvedへの変更には、ユーザー本人の明示的な記事承認が必要です。');
  }
  const draft = await loadDraft({ draftsDir, slug });
  const current = draft.data.workflowStatus;
  if (!statusTransitions[current]?.has(workflowStatus)) {
    throw new Error('状態遷移できません: ' + String(current) + ' → ' + String(workflowStatus));
  }
  const validation = await validateDraft({ draftsDir, contentDir, slug, workflowStatus });
  if (validation.issues.length) throw new Error('検証に失敗しました:\n- ' + validation.issues.join('\n- '));
  const data = { ...draft.data, workflowStatus, updatedDate: localDate(now), draft: true };
  await writeAtomic(draft.file, matter.stringify(draft.content, data));
  return { slug, workflowStatus, file: draft.file };
}

export async function listArticles({ draftsDir = defaultDraftsDir, contentDir = defaultContentDir }) {
  const entries = [];
  for (const file of (await collectArticleFiles(draftsDir)).filter((item) => path.basename(item) === 'index.md')) {
    const parsed = matter(await readFile(file, 'utf8'));
    entries.push({
      status: parsed.data.workflowStatus ?? 'Draft',
      id: path.basename(path.dirname(file)),
      title: parsed.data.title ?? '(タイトル未設定)',
      category: parsed.data.category ?? '—',
      date: displayDate(parsed.data.updatedDate ?? parsed.data.pubDate),
      slug: parsed.data.slug ?? path.basename(path.dirname(file)),
      image: parsed.data.cover ? 'coverあり' : 'cover未設定',
      location: path.relative(draftsDir, file),
    });
  }
  for (const file of await collectArticleFiles(contentDir)) {
    const parsed = matter(await readFile(file, 'utf8'));
    if (parsed.data.draft !== false) continue;
    entries.push({
      status: 'Published',
      title: parsed.data.title ?? '(タイトル未設定)',
      category: parsed.data.category ?? '—',
      date: displayDate(parsed.data.updatedDate ?? parsed.data.pubDate),
      slug: parsed.data.slug ?? path.basename(path.dirname(file)),
      image: parsed.data.cover ? 'coverあり' : 'cover未設定',
      location: 'https://mizukioyama.github.io/blog/posts/' + (parsed.data.slug ?? '') + '/',
    });
  }
  return entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function parseNewOptions(args) {
  const options = { topic: '', notes: '', category: 'Creative' };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (['--topic', '--notes', '--category'].includes(args[index])) {
      const key = args[index].slice(2);
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(key + ' の値を指定してください。');
      options[key] = value;
      index += 1;
    } else if (args[index] === '--help' || args[index] === '-h') {
      return { ...options, help: true };
    } else {
      positional.push(args[index]);
    }
  }
  if (!options.topic) options.topic = positional.join(' ').trim();
  if (!options.topic) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { options.topic = (await prompt.question('記事テーマまたはメモ: ')).trim(); }
    finally { prompt.close(); }
  }
  return options;
}

function printHelp() {
  console.log([
    '記事運用コマンド',
    '  npm run article:new -- --topic "テーマ" [--notes "メモ"] [--category Art|Exhibition|Creative]',
    '  npm run article:save -- <draft-id>  # 標準入力のJSONをDraftへ原子的に保存',
    '  npm run article:asset -- <draft-id> <生成画像の一時ファイル> <cover.png>',
    '  npm run article:list',
    '  npm run article:validate -- <draft-id>',
    '  npm run article:status -- <draft-id> <Draft|Review|Approved> [--user-confirmed]',
    '  npm run article:backup -- <draft-id>',
    '  npm run article:restore -- <backup-id> [restore-as-id]',
    '  npm run article:recover -- <draft-id>',
    '  npm run article:preview -- <draft-id>',
    '',
    'Approvedにはユーザー本人の明示的な記事承認が必要です。',
    'どのコマンドもcommit / push / 公開は実行しません。',
  ].join('\n'));
}

async function runPreview(slug, draftsDir) {
  const draft = await loadDraft({ draftsDir, slug });
  if (!['Draft', 'Review', 'Approved'].includes(draft.data.workflowStatus)) throw new Error('ローカル下書きの状態を確認できません。');
  const port = Number(process.env.ARTICLE_PREVIEW_PORT ?? 4321);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ARTICLE_PREVIEW_PORT は1024〜65535の整数にしてください。');
  const cli = path.join(repoRoot, 'node_modules/astro/bin/astro.mjs');
  const url = 'http://127.0.0.1:' + port + '/blog/draft-preview/' + encodeURIComponent(draft.data.slug) + '/';
  console.log('ローカル限定プレビューを起動します: ' + url);
  console.log('終了するときは Ctrl+C を押してください。');
  const child = spawn(process.execPath, [cli, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', (error) => {
    console.error('プレビューを起動できませんでした: ' + error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
  });
}

async function readJsonInput() {
  if (process.stdin.isTTY) throw new Error('記事JSONを標準入力から渡してください。');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error('記事JSONを読み取れません: ' + error.message);
  }
}

export async function runCommand(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const draftsDir = process.env.ARTICLE_DRAFTS_DIR ?? defaultDraftsDir;
  const contentDir = process.env.ARTICLE_CONTENT_DIR ?? defaultContentDir;
  const plansDir = process.env.ARTICLE_PUBLICATION_DIR ?? defaultPlansDir;
  if (!command || command === '--help' || command === '-h') return printHelp();

  if (command === 'new') {
    const options = await parseNewOptions(rest);
    if (options.help) return printHelp();
    const created = await createDraft({ draftsDir, ...options });
    console.log('ローカル下書きを作成しました: ' + created.draftId);
    console.log('ブリーフ: ' + created.briefPath);
    console.log('記事: ' + created.articlePath);
    console.log('Workは記事案を作り、article:saveでまとめて保存してください。');
    return;
  }

  if (command === 'save') {
    const [draftId] = rest;
    if (!draftId) throw new Error('保存先のdraft IDを指定してください。');
    const input = await readJsonInput();
    const saved = await saveDraftArticle({
      draftsDir,
      contentDir,
      draftId,
      data: input.data,
      content: input.content,
      brief: input.brief,
    });
    console.log('ローカル下書きをDraftのまま保存しました: ' + saved.draftId + ' (' + saved.slug + ')');
    console.log('記事: ' + saved.file);
    if (saved.recoveryCleanupPending) {
      console.warn('保存は完了しましたが復旧用データを保持しています。npm run article:recover -- ' + draftId + ' で整理してください: ' + saved.recoveryCleanupPending);
    }
    return;
  }

  if (command === 'asset') {
    const [draftId, sourcePath, fileName] = rest;
    if (!draftId || !sourcePath || !fileName) throw new Error('draft ID、画像生成の一時ファイル、保存ファイル名を指定してください。');
    const asset = await storeGeneratedAsset({ draftsDir, draftId, sourcePath, fileName });
    console.log('生成画像を下書きへ保存しました: ' + asset.relativePath);
    return;
  }

  if (command === 'recover') {
    const [draftId] = rest;
    if (!draftId) throw new Error('復旧するdraft IDを指定してください。');
    const result = await recoverInterruptedDraftSave({ draftsDir, draftId });
    console.log(result.recovered ? '中断した保存を元データへ復旧しました: ' + draftId : '復旧対象はありません: ' + draftId);
    return;
  }

  if (command === 'list') {
    const entries = await listArticles({ draftsDir, contentDir });
    if (!entries.length) {
      console.log('記事とローカル下書きはまだありません。');
      return;
    }
    console.log('DRAFT_ID\tSTATUS\tTITLE\tCATEGORY\tDATE\tIMAGE\tSLUG\tLOCATION');
    for (const entry of entries) {
      console.log([entry.id ?? '—', entry.status, entry.title, entry.category, entry.date, entry.image, entry.slug, entry.location].join('\t'));
    }
    return;
  }

  if (command === 'validate') {
    const [slug] = rest;
    if (!slug) throw new Error('検証するslugを指定してください。');
    const result = await validateDraft({ draftsDir, contentDir, plansDir, slug, allowVerifiedPublicationPair: true });
    if (result.issues.length) throw new Error('下書きに問題があります:\n- ' + result.issues.join('\n- '));
    console.log('下書き検証 OK: ' + slug + ' (' + result.data.workflowStatus + ')');
    return;
  }

  if (command === 'status') {
    const [slug, workflowStatus, ...flags] = rest;
    if (!slug || !workflowStatus) throw new Error('draft ID と Draft / Review / Approved の状態を指定してください。');
    const updated = await updateDraftStatus({ draftsDir, contentDir, slug, workflowStatus, confirmedByUser: flags.includes('--user-confirmed') });
    console.log('状態を更新しました: ' + updated.slug + ' → ' + updated.workflowStatus);
    if (workflowStatus === 'Approved') console.log('状態変更のみです。会話上の承認証跡やGitHub公開許可を証明・保存しません。');
    return;
  }

  if (command === 'backup') {
    const [draftId] = rest;
    if (!draftId) throw new Error('バックアップするdraft IDを指定してください。');
    const backup = await backupDraft({ draftsDir, draftId });
    console.log('ローカルバックアップを作成しました: ' + backup.backupId);
    console.log('保存先: ' + backup.path);
    return;
  }

  if (command === 'restore') {
    const [backupId, restoreAs] = rest;
    if (!backupId) throw new Error('復元するbackup IDを指定してください。');
    const restored = await restoreDraft({ draftsDir, backupId, restoreAs });
    console.log('下書きを上書きせず復元しました: ' + restored.draftId);
    console.log('復元後にarticle:validateで検証してください。');
    return;
  }

  if (command === 'preview') {
    const [slug] = rest;
    if (!slug) throw new Error('プレビューするslugを指定してください。');
    await runPreview(slug, draftsDir);
    return;
  }

  throw new Error('不明なコマンドです: ' + command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCommand().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
