import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { validateArticleData } from '../scripts/article-validation.mjs';
import {
  backupDraft,
  createDraft,
  loadDraft,
  restoreDraft,
  recoverInterruptedDraftSave,
  saveDraftArticle,
  storeGeneratedAsset,
  updateDraftStatus,
  validateDraft,
} from '../scripts/article-workflow.mjs';

async function withWorkspace(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-article-workflow-'));
  const draftsDir = path.join(root, '.private-drafts');
  const backupsDir = path.join(root, '.private-draft-backups');
  const contentDir = path.join(root, 'src/content/blog');
  await mkdir(contentDir, { recursive: true });
  try {
    await callback({ root, draftsDir, backupsDir, contentDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function articlePayload(overrides = {}) {
  const { data: dataOverrides = {}, ...otherOverrides } = overrides;
  return {
    data: {
      title: '架空の紙作品「光の採集」',
      seoTitle: '架空の制作記録「光の採集」',
      slug: 'fictional-paper-light-collection',
      description: 'この記事は架空のテスト用原稿です。紙の作品づくりを想定し、制作の流れとアイキャッチ案を確認するための内容をまとめています。',
      pubDate: '2026-10-18',
      category: 'Creative',
      tags: ['架空の検証'],
      ...dataOverrides,
    },
    content: '## 制作の記録\n\n' + 'この記事は架空のテスト記事です。実在の人物、展示、作品、出来事についての主張は含めず、制作工程の保存と表示を確かめます。'.repeat(8) + '\n\n## アイキャッチ案\n\n紙の重なりを抽象的に描いた画像を想定します。\n',
    brief: '# 記事制作ブリーフ\n\n## 事実確認\n\n架空の検証記事です。実在情報は使用していません。\n\n## アイキャッチ\n\nコンセプト: 光を受ける抽象的な紙の重なり\n掲載コピー: 光の採集\nサイズ: 1200 × 630 px\nalt: 淡い紙片が重なり、柔らかな光が差す抽象イラスト\nファイル名: cover.png\n',
    ...otherOverrides,
  };
}

function runWorkflowCli(args, { draftsDir, contentDir }, input) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/article-workflow.mjs', import.meta.url)), ...args], {
    cwd: path.dirname(draftsDir),
    env: { ...process.env, ARTICLE_DRAFTS_DIR: draftsDir, ARTICLE_CONTENT_DIR: contentDir },
    input,
    encoding: 'utf8',
  });
}

test('runs the article workflow through the same CLI used by Work', async () => {
  await withWorkspace(async ({ draftsDir, contentDir }) => {
    const created = runWorkflowCli(['new', '--topic', '架空の制作記事を自然言語から作る検証', '--notes', '事実を作らない架空テスト', '--category', 'Creative'], { draftsDir, contentDir });
    assert.equal(created.status, 0, created.stderr);
    const draftId = /ローカル下書きを作成しました: ([a-z0-9-]+)/.exec(created.stdout)?.[1];
    assert.ok(draftId, created.stdout);

    const saved = runWorkflowCli(['save', draftId], { draftsDir, contentDir }, JSON.stringify(articlePayload()));
    assert.equal(saved.status, 0, saved.stderr);
    const validated = runWorkflowCli(['validate', draftId], { draftsDir, contentDir });
    assert.equal(validated.status, 0, validated.stderr);
    const reviewed = runWorkflowCli(['status', draftId, 'Review'], { draftsDir, contentDir });
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const approved = runWorkflowCli(['status', draftId, 'Approved'], { draftsDir, contentDir });
    assert.notEqual(approved.status, 0);
    assert.match(approved.stderr, /ユーザー本人の明示的な記事承認/);
  });
});

test('creates a private draft and complete brief without a manual terminal prompt', async () => {
  await withWorkspace(async ({ draftsDir, contentDir }) => {
    const created = await createDraft({
      draftsDir,
      topic: '架空の紙作品「光の採集」の制作記録',
      notes: '架空の検証テーマ。実在する展示や個人の体験としては扱わない。',
      category: 'Creative',
      now: new Date(2026, 9, 18, 12, 30, 45),
    });
    assert.match(created.draftId, /^draft-\d{8}-\d{6}$/);
    const reopened = await loadDraft({ draftsDir, slug: created.draftId });
    const brief = await readFile(created.briefPath, 'utf8');
    assert.equal(reopened.data.workflowStatus, 'Draft');
    assert.equal(reopened.data.draft, true);
    assert.match(brief, /架空の検証テーマ/);
    assert.match(brief, /アイキャッチ案/);
    assert.equal((await validateDraft({ draftsDir, contentDir, slug: created.draftId })).data.workflowStatus, 'Draft');
  });
});

test('saves generated article and image atomically, validates, previews as Review, and supports safe revisions', async () => {
  await withWorkspace(async ({ root, draftsDir, contentDir }) => {
    const created = await createDraft({ draftsDir, topic: '架空の紙作品「光の採集」' });
    const generatedImage = path.join(root, 'generated-test.png');
    await writeFile(generatedImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'));
    const asset = await storeGeneratedAsset({ draftsDir, draftId: created.draftId, sourcePath: generatedImage, fileName: 'cover.png' });
    const payload = articlePayload({ data: {
      cover: asset.relativePath,
      coverAlt: '架空記事用の小さなテスト画像。淡い紙片のイメージ。',
      ogImage: asset.relativePath,
      ogImageAlt: '架空記事用の抽象的なテスト画像。',
    } });
    const saved = await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...payload });
    assert.equal(saved.data.workflowStatus, 'Draft');
    assert.equal(saved.data.draft, true);
    assert.equal((await validateDraft({ draftsDir, contentDir, slug: created.draftId })).issues.length, 0);

    const beforeBadSave = await readFile(created.articlePath, 'utf8');
    await assert.rejects(saveDraftArticle({
      draftsDir,
      contentDir,
      draftId: created.draftId,
      ...articlePayload({ data: { slug: '../outside' } }),
    }), /保存前検証に失敗/);
    assert.equal(await readFile(created.articlePath, 'utf8'), beforeBadSave);

    await updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Review' });
    await assert.rejects(
      updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Approved' }),
      /ユーザー本人の明示的な記事承認/,
    );
    assert.equal((await loadDraft({ draftsDir, slug: created.draftId })).data.workflowStatus, 'Review');

    await updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Draft' });
    const revised = articlePayload({ data: { title: '架空の紙作品「光の採集」改訂版' } });
    await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...revised });
    await updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Review' });
    const reviewed = await loadDraft({ draftsDir, slug: created.draftId });
    assert.equal(reviewed.data.title, '架空の紙作品「光の採集」改訂版');
    assert.equal(reviewed.data.workflowStatus, 'Review');
    assert.equal(reviewed.data.draft, true);
  });
});

test('requires an explicit user confirmation before moving Review to Approved', async () => {
  await withWorkspace(async ({ draftsDir, contentDir }) => {
    const created = await createDraft({ draftsDir, topic: '承認ゲートの架空テスト' });
    await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...articlePayload() });
    await updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Review' });
    await assert.rejects(
      updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Approved' }),
      /ユーザー本人の明示的な記事承認/,
    );
    const approved = await updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Approved', confirmedByUser: true });
    assert.equal(approved.workflowStatus, 'Approved');
  });
});

test('backs up and restores a draft without overwriting existing folders', async () => {
  await withWorkspace(async ({ draftsDir, backupsDir, contentDir }) => {
    const created = await createDraft({ draftsDir, topic: '復元テスト' });
    const payload = articlePayload();
    await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...payload });
    const backup = await backupDraft({ draftsDir, backupsDir, draftId: created.draftId, now: new Date('2026-10-18T12:30:00Z') });
    const original = await loadDraft({ draftsDir, slug: created.draftId });
    await rm(original.directory, { recursive: true });
    const restored = await restoreDraft({ draftsDir, backupsDir, backupId: backup.backupId });
    const restoredArticle = await loadDraft({ draftsDir, slug: restored.draftId });
    assert.equal(restoredArticle.data.title, payload.data.title);
    assert.equal(restoredArticle.content, payload.content);
    await assert.rejects(restoreDraft({ draftsDir, backupsDir, backupId: backup.backupId }), /既存/);
  });
});

test('keeps backup storage separate from the private draft root', async () => {
  await withWorkspace(async ({ draftsDir }) => {
    const created = await createDraft({ draftsDir, topic: 'バックアップ保存先のテスト' });
    await assert.rejects(backupDraft({ draftsDir, backupsDir: draftsDir, draftId: created.draftId }), /分離してください/);
    assert.deepEqual(await readdir(draftsDir), [created.draftId]);
  });
});

test('rejects path traversal and symlink draft folders', async () => {
  await withWorkspace(async ({ root, draftsDir }) => {
    await mkdir(draftsDir, { recursive: true });
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'index.md'), matter.stringify('private', { title: 'outside' }));
    await symlink(path.join(root, 'outside'), path.join(draftsDir, 'linked-draft'));
    await assert.rejects(loadDraft({ draftsDir, slug: '../outside' }), /小文字英数字/);
    await assert.rejects(loadDraft({ draftsDir, slug: 'linked-draft' }), /安全な通常ディレクトリ/);
    await mkdir(path.join(draftsDir, 'safe-root-test'));
    await writeFile(path.join(draftsDir, 'safe-root-test', 'index.md'), '---\ntitle: test\n---\nbody');
    const linkedRoot = path.join(root, 'linked-drafts-root');
    await symlink(draftsDir, linkedRoot);
    await assert.rejects(loadDraft({ draftsDir: linkedRoot, slug: 'safe-root-test' }), /通常のローカルフォルダー/);
  });
});

test('refuses to restore into a symlinked draft root', async () => {
  await withWorkspace(async ({ root, draftsDir, backupsDir, contentDir }) => {
    const created = await createDraft({ draftsDir, topic: '復元先リンクのテスト' });
    await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...articlePayload() });
    const backup = await backupDraft({ draftsDir, backupsDir, draftId: created.draftId });
    await rm(created.directory, { recursive: true });
    const outside = path.join(root, 'outside-drafts');
    await mkdir(outside);
    await rm(draftsDir, { recursive: true });
    await symlink(outside, draftsDir);
    await assert.rejects(restoreDraft({ draftsDir, backupsDir, backupId: backup.backupId }), /通常のローカルフォルダー/);
    assert.deepEqual(await readdir(outside), []);
  });
});


test('image asset names cannot escape the draft folder or overwrite an existing file', async () => {
  await withWorkspace(async ({ root, draftsDir }) => {
    const created = await createDraft({ draftsDir, topic: '画像パスのテスト' });
    const source = path.join(root, 'generated.png');
    await writeFile(source, Buffer.from('test image'));
    await assert.rejects(storeGeneratedAsset({ draftsDir, draftId: created.draftId, sourcePath: source, fileName: '../escape.png' }), /安全な英数字名/);
    await storeGeneratedAsset({ draftsDir, draftId: created.draftId, sourcePath: source, fileName: 'cover.png' });
    await assert.rejects(storeGeneratedAsset({ draftsDir, draftId: created.draftId, sourcePath: source, fileName: 'cover.png' }), /上書きしません/);
  });
});

test('restores both original draft files when the second atomic replacement fails', async () => {
  await withWorkspace(async ({ draftsDir, contentDir }) => {
    const created = await createDraft({ draftsDir, topic: '隔離した二ファイル保存失敗テスト' });
    const initial = articlePayload({ data: { slug: created.draftId.replace(/^draft-/, 'isolated-save-') } });
    await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...initial });
    const originalArticle = await readFile(created.articlePath);
    const originalBrief = await readFile(created.briefPath);
    const next = articlePayload({
      data: { slug: initial.data.slug, title: '更新途中で失敗する架空記事' },
      brief: '# 更新後ブリーフ\n\nこの内容は保存失敗で残ってはいけません。\n',
    });
    let failedBriefRename = false;
    const renameWithSecondFileFailure = async (source, target) => {
      if (path.basename(target) === 'brief.md' && !failedBriefRename) {
        failedBriefRename = true;
        throw new Error('injected second-file replacement failure');
      }
      return rename(source, target);
    };

    await assert.rejects(
      saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...next, renameFile: renameWithSecondFileFailure }),
      /元のindex\.mdとbrief\.mdを復元しました/,
    );
    assert.equal(await readFile(created.articlePath, 'utf8'), originalArticle.toString('utf8'));
    assert.equal(await readFile(created.briefPath, 'utf8'), originalBrief.toString('utf8'));
  });
});

test('preserves recovery snapshots if rollback fails and restores them on request', async () => {
  await withWorkspace(async ({ draftsDir, contentDir }) => {
    const created = await createDraft({ draftsDir, topic: '復旧フォルダーの隔離テスト' });
    const initial = articlePayload({ data: { slug: created.draftId.replace(/^draft-/, 'isolated-recovery-') } });
    await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...initial });
    const originalArticle = await readFile(created.articlePath);
    const originalBrief = await readFile(created.briefPath);
    const next = articlePayload({
      data: { slug: initial.data.slug, title: '復元も失敗する架空記事' },
      brief: '# 更新後ブリーフ\n\n復旧コピーをテストします。\n',
    });
    let failedBriefRename = false;
    let articleRenameCount = 0;
    const failUpdateAndRollback = async (source, target) => {
      if (path.basename(target) === 'brief.md' && !failedBriefRename) {
        failedBriefRename = true;
        throw new Error('injected second-file replacement failure');
      }
      if (path.basename(target) === 'index.md') {
        articleRenameCount += 1;
        if (articleRenameCount === 2) throw new Error('injected rollback failure');
      }
      return rename(source, target);
    };

    await assert.rejects(
      saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...next, renameFile: failUpdateAndRollback }),
      /元データは復旧フォルダーに保全しています/,
    );
    const recoveryName = (await readdir(created.directory)).find((name) => name.startsWith('.article-save-recovery-'));
    assert.ok(recoveryName);
    const recoveryDirectory = path.join(created.directory, recoveryName);
    assert.equal(await readFile(path.join(recoveryDirectory, 'index.md'), 'utf8'), originalArticle.toString('utf8'));
    assert.equal(await readFile(path.join(recoveryDirectory, 'brief.md'), 'utf8'), originalBrief.toString('utf8'));

    const result = await recoverInterruptedDraftSave({ draftsDir, draftId: created.draftId });
    assert.equal(result.recovered, 1);
    assert.equal(await readFile(created.articlePath, 'utf8'), originalArticle.toString('utf8'));
    assert.equal(await readFile(created.briefPath, 'utf8'), originalBrief.toString('utf8'));
    assert.equal((await readdir(created.directory)).some((name) => name.startsWith('.article-save-recovery-')), false);
  });
});

test('validates public cover and OGP images as contained regular files', async () => {
  await withWorkspace(async ({ root }) => {
    const articleDirectory = path.join(root, 'src/content/blog/creative/safe-article');
    const outsideDirectory = path.join(root, 'outside');
    await mkdir(articleDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(path.join(articleDirectory, 'cover.png'), 'cover');
    await writeFile(path.join(articleDirectory, 'og.png'), 'og');
    await writeFile(path.join(outsideDirectory, 'outside.png'), 'outside');
    await symlink(path.join(outsideDirectory, 'outside.png'), path.join(articleDirectory, 'linked-cover.png'));
    await symlink(path.join(outsideDirectory, 'outside.png'), path.join(articleDirectory, 'linked-og.png'));
    await mkdir(path.join(articleDirectory, 'image-directory'));

    const data = {
      title: '公開画像パス検証の架空記事',
      slug: 'safe-article',
      description: '公開記事の画像参照が安全な通常ファイルに限定されることを確認するための十分な長さの説明文です。',
      pubDate: '2026-10-18',
      category: 'Creative',
      tags: [],
      draft: true,
      cover: './cover.png',
      coverAlt: 'テスト用の通常画像',
      ogImage: './og.png',
      ogImageAlt: 'OGPテスト用の通常画像',
    };
    const validContent = '架空の検証本文です。\n';
    const validIssues = await validateArticleData({ data, content: validContent, directory: articleDirectory });
    assert.deepEqual(validIssues, []);

    const traversalIssues = await validateArticleData({
      data: { ...data, cover: '../outside/outside.png', ogImage: '../outside/outside.png' },
      content: validContent,
      directory: articleDirectory,
    });
    assert.ok(traversalIssues.some((issue) => issue.startsWith('cover は記事フォルダー内')));
    assert.ok(traversalIssues.some((issue) => issue.startsWith('ogImage は記事フォルダー内')));

    const symlinkIssues = await validateArticleData({
      data: { ...data, cover: './linked-cover.png', ogImage: './linked-og.png' },
      content: validContent,
      directory: articleDirectory,
    });
    assert.ok(symlinkIssues.some((issue) => issue.startsWith('cover は') && issue.includes('通常ファイル')));
    assert.ok(symlinkIssues.some((issue) => issue.startsWith('ogImage は') && issue.includes('通常ファイル')));

    const directoryIssues = await validateArticleData({
      data: { ...data, cover: './image-directory' },
      content: validContent,
      directory: articleDirectory,
    });
    assert.ok(directoryIssues.some((issue) => issue.startsWith('cover は') && issue.includes('通常ファイル')));
  });
});
