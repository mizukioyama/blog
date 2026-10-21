import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cp, lstat, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import {
  backupDraft, createDraft, saveDraftArticle, updateDraftStatus,
} from '../scripts/article-workflow.mjs';
import {
  materializePublication, preparePublication, recordCandidateApproval, verifyCandidateApproval, verifyLivePublication,
} from '../scripts/article-publication.mjs';
import { validateArticleFile } from '../scripts/article-validation.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const publicationModule = fileURLToPath(new URL('../scripts/article-publication.mjs', import.meta.url));
const fixtureSlug = 'phase2b-fictional-publication-fixture';
const fixtureTitle = '架空の紙と光の制作記録';
const privateBodySentinel = 'PHASE2B_PUBLIC_CANDIDATE_BODY_8391';
const privateDraftIdSentinel = 'draft-phase2b-private-fixture-8391';
const svg = (color) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="${color}"/></svg>`);

async function withWorkspace(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-article-publication-'));
  const draftsDir = path.join(root, '.private-drafts');
  const backupsDir = path.join(root, '.private-draft-backups');
  const contentDir = path.join(root, 'src/content/blog');
  const plansDir = path.join(root, '.private-publication');
  const publicDir = path.join(root, 'public');
  await Promise.all([
    mkdir(draftsDir, { recursive: true }), mkdir(backupsDir, { recursive: true }),
    mkdir(contentDir, { recursive: true }), mkdir(publicDir, { recursive: true }),
  ]);
  await writeFile(path.join(publicDir, 'og-image.png'), Buffer.from('site default OGP fixture'));
  try { await callback({ root, draftsDir, backupsDir, contentDir, plansDir, publicDir }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function fixtureArticle(draftId, overrides = {}) {
  return {
    data: {
      title: fixtureTitle,
      seoTitle: '架空の制作記録「紙と光」',
      slug: fixtureSlug,
      description: 'これは記事公開ワークフローの架空テストです。実在する人物、展示、作品、開催情報、本人の体験を含まないフィクスチャとして使用します。',
      pubDate: '2026-10-19',
      category: 'Creative',
      tags: ['phase2b-fixture'],
      cover: './phase2b-public-cover.png',
      coverAlt: '公開候補fixture用の架空イラスト。淡い紙の形を配置した画像。',
      ogImage: './phase2b-public-og.png',
      ogImageAlt: '公開候補fixture用の架空OGP画像。紙と光を抽象的に表現。',
      ...overrides.data,
    },
    content: [
      '## 架空の制作記録',
      '',
      (privateBodySentinel + '。この記事は公開候補フローの隔離テスト用で、実在の経験や事実を表しません。').repeat(7),
      '',
      '![架空の本文画像](./phase2b-public-body.png)',
      '',
      '[ブログのトップ](/blog/)',
      '',
    ].join('\n'),
    brief: [
      '# 架空の制作ブリーフ',
      '',
      '実在情報・個人の体験は含まない隔離テストです。',
      '',
      '## 画像',
      '',
      'テスト専用のSVGフィクスチャを使用します。',
      '',
    ].join('\n'),
  };
}

async function createReviewFixture({ draftsDir, contentDir, publicDir, now = new Date('2026-10-19T00:00:00.000Z'), slug = fixtureSlug } = {}) {
  const created = await createDraft({ draftsDir, topic: '架空の紙と光の制作記録', category: 'Creative', now });
  await Promise.all([
    writeFile(path.join(created.directory, 'phase2b-public-cover.png'), await readFile(path.join(repoRoot, 'public/og-image.png'))),
    writeFile(path.join(created.directory, 'phase2b-public-og.png'), await readFile(path.join(repoRoot, 'public/og-image.png'))),
    writeFile(path.join(created.directory, 'phase2b-public-body.png'), await readFile(path.join(repoRoot, 'public/og-image.png'))),
    writeFile(path.join(publicDir, 'og-image.png'), Buffer.from('site default OGP fixture')),
  ]);
  const article = fixtureArticle(created.draftId, { data: { slug } });
  await saveDraftArticle({ draftsDir, contentDir, draftId: created.draftId, ...article });
  await updateDraftStatus({ draftsDir, contentDir, slug: created.draftId, workflowStatus: 'Review' });
  return { ...created, article, draftId: created.draftId };
}

async function prepareFixture(context, fixture) {
  return preparePublication({
    draftsDir: context.draftsDir,
    contentDir: context.contentDir,
    plansDir: context.plansDir,
    backupsDir: context.backupsDir,
    publicOgImage: path.join(context.publicDir, 'og-image.png'),
    draftId: fixture.draftId,
    now: new Date('2026-10-19T01:02:03.000Z'),
  });
}

async function approveFixture(context, fixture, plan) {
  const common = {
    draftsDir: context.draftsDir,
    plansDir: context.plansDir,
    planId: plan.planId,
    candidateSha256: plan.candidateSha256,
  };
  await recordCandidateApproval({
    ...common,
    kind: 'content',
    approvalReference: 'fictional test content approval ' + plan.planId,
    now: new Date('2026-10-20T00:00:00.000Z'),
  });
  await updateDraftStatus({
    draftsDir: context.draftsDir, contentDir: context.contentDir, slug: fixture.draftId,
    workflowStatus: 'Approved', confirmedByUser: true,
  });
  await recordCandidateApproval({
    ...common,
    kind: 'github-publication',
    approvalReference: 'fictional test publication approval ' + plan.planId,
    authorizedActions: ['materialize', 'stage', 'commit', 'push', 'workflow_dispatch'],
    now: new Date('2026-10-20T00:01:00.000Z'),
  });
}

function runPublicationCli(args, context) {
  return spawnSync(process.execPath, [publicationModule, ...args], {
    cwd: context.root,
    env: {
      ...process.env,
      ARTICLE_DRAFTS_DIR: context.draftsDir,
      ARTICLE_CONTENT_DIR: context.contentDir,
      ARTICLE_BACKUPS_DIR: context.backupsDir,
      ARTICLE_PUBLICATION_DIR: context.plansDir,
    },
    encoding: 'utf8',
  });
}

function runFixtureGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function runGitScopeCli(modulePath, args, context) {
  return spawnSync(process.execPath, [modulePath, ...args], {
    cwd: context.root,
    env: {
      ...process.env,
      ARTICLE_DRAFTS_DIR: context.draftsDir,
      ARTICLE_CONTENT_DIR: context.contentDir,
      ARTICLE_BACKUPS_DIR: context.backupsDir,
      ARTICLE_PUBLICATION_DIR: context.plansDir,
    },
    encoding: 'utf8',
  });
}

async function initializeGitScopeFixture(context, plan, { candidateInBase = false } = {}) {
  const scriptDirectory = path.join(context.root, 'scripts');
  await mkdir(scriptDirectory, { recursive: true });
  const fixtureModule = path.join(scriptDirectory, 'article-publication.mjs');
  await cp(publicationModule, fixtureModule);
  await cp(path.join(repoRoot, 'scripts/article-validation.mjs'), path.join(scriptDirectory, 'article-validation.mjs'));
  await symlink(path.join(repoRoot, 'node_modules'), path.join(context.root, 'node_modules'), 'dir');

  const manifest = JSON.parse(await readFile(path.join(context.plansDir, plan.planId, 'plan.json'), 'utf8'));
  const repoPaths = manifest.candidate.files.map((file) =>
    'src/content/blog/' + manifest.candidate.targetDirectory + '/' + file.path);
  await writeFile(path.join(context.root, 'README.md'), 'Fictional isolated Git gate fixture.\\n');
  if (candidateInBase) {
    for (const file of manifest.candidate.files) {
      const destination = path.join(context.contentDir, manifest.candidate.targetDirectory, ...file.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(context.plansDir, plan.planId, 'payload', ...file.path.split('/'))));
    }
  }

  runFixtureGit(context.root, ['init', '-b', 'main']);
  runFixtureGit(context.root, ['config', 'user.name', 'Fictional Article Fixture']);
  runFixtureGit(context.root, ['config', 'user.email', 'fictional@example.invalid']);
  runFixtureGit(context.root, ['remote', 'add', 'origin', 'https://github.com/mizukioyama/blog.git']);
  const baseFiles = ['README.md', ...(candidateInBase ? repoPaths : [])];
  runFixtureGit(context.root, ['add', '--', ...baseFiles]);
  runFixtureGit(context.root, ['commit', '-m', 'fictional isolated base']);
  const baseCommit = runFixtureGit(context.root, ['rev-parse', 'HEAD']).trim();
  runFixtureGit(context.root, ['update-ref', 'refs/remotes/origin/main', baseCommit]);
  return { modulePath: await realpath(fixtureModule), repoPaths, manifest, baseCommit };
}

async function createGitScopeScenario(context, { candidateInBase = false } = {}) {
  const fixture = await createReviewFixture(context);
  const plan = await prepareFixture(context, fixture);
  await approveFixture(context, fixture, plan);
  const gitFixture = await initializeGitScopeFixture(context, plan, { candidateInBase });
  if (!candidateInBase) {
    await materializePublication({
      draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir,
      planId: plan.planId, candidateSha256: plan.candidateSha256,
    });
  }
  return { fixture, plan, ...gitFixture };
}

function checkGitScope(context, scenario, phase = 'index', candidateSha256 = scenario.plan.candidateSha256) {
  return runGitScopeCli(scenario.modulePath, [
    'check-git-scope', scenario.plan.planId,
    '--candidate-sha', candidateSha256,
    '--phase', phase,
  ], context);
}

async function collectFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(full, relative));
    else result.push(relative);
  }
  return result.sort();
}

async function linkDependencies(temporaryRoot) {
  const localModules = path.join(temporaryRoot, 'node_modules');
  await mkdir(localModules);
  for (const entry of await readdir(path.join(repoRoot, 'node_modules'), { withFileTypes: true })) {
    if (entry.name === '.vite' || entry.name === '.astro') continue;
    await symlink(path.join(repoRoot, 'node_modules', entry.name), path.join(localModules, entry.name), 'dir');
  }
  await mkdir(path.join(localModules, '.vite'));
  await mkdir(path.join(localModules, '.astro'));
}

async function createBuildWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-article-publication-build-'));
  for (const name of ['astro.config.mjs', 'package.json', 'tsconfig.json', 'src', 'public', 'scripts']) {
    await cp(path.join(repoRoot, name), path.join(root, name), { recursive: true });
  }
  await mkdir(path.join(root, '.private-drafts'), { recursive: true });
  await mkdir(path.join(root, '.private-draft-backups'), { recursive: true });
  await linkDependencies(root);
  return root;
}

async function walkFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...await walkFiles(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

test('prepares a Review article into a private, hash-bound candidate without touching public content', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const indexBefore = await readFile(fixture.articlePath);
    const briefBefore = await readFile(fixture.briefPath);
    const imageBefore = await readFile(path.join(fixture.directory, 'phase2b-public-cover.png'));
    const cli = runPublicationCli(['prepare', fixture.draftId], context);
    assert.equal(cli.status, 0, cli.stderr);
    const plan = JSON.parse(cli.stdout.slice(0, cli.stdout.indexOf('\n候補内容')));

    assert.equal(plan.title, fixtureTitle);
    assert.equal(plan.slug, fixtureSlug);
    assert.equal(plan.publicUrl, `https://mizukioyama.github.io/blog/posts/${fixtureSlug}/`);
    assert.match(plan.candidateSha256, /^[a-f0-9]{64}$/);
    assert.ok(plan.targetFiles.some((file) => file.endsWith('/index.md')));
    assert.equal(plan.targetFiles.length, 4);
    assert.ok(plan.humanReviewRequired.some((item) => item.includes('意味上の重複')));
    assert.equal(await lstat(path.join(context.contentDir, 'creative', fixtureSlug)).then(() => true, () => false), false);
    assert.deepEqual(await readFile(fixture.articlePath), indexBefore);
    assert.deepEqual(await readFile(fixture.briefPath), briefBefore);
    assert.deepEqual(await readFile(path.join(fixture.directory, 'phase2b-public-cover.png')), imageBefore);
    const planFile = path.join(context.plansDir, plan.planId, 'plan.json');
    const manifest = JSON.parse(await readFile(planFile, 'utf8'));
    assert.equal(manifest.source.statusAtPreparation, 'Review');
    assert.ok(!JSON.stringify(manifest).includes(context.root));
    assert.ok(!manifest.candidate.targetFiles.some((file) => file.includes('brief.md') || file.includes('draft-')));
  });
});

test('requires exact candidate binding and Approved status, then materializes without overwriting or moving the private draft', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const backup = await backupDraft({ draftsDir: context.draftsDir, backupsDir: context.backupsDir, draftId: fixture.draftId, now: new Date('2026-10-19T02:00:00.000Z') });
    const backupIndexBefore = await readFile(path.join(backup.path, 'index.md'));
    const backupBriefBefore = await readFile(path.join(backup.path, 'brief.md'));
    const originalBody = matter(await readFile(fixture.articlePath, 'utf8')).content;
    const privateCoverBefore = await readFile(path.join(fixture.directory, 'phase2b-public-cover.png'));
    const plan = await prepareFixture(context, fixture);
    await assert.rejects(
      materializePublication({ draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 }),
      /Approved下書きが必要/,
    );
    await recordCandidateApproval({
      draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId,
      candidateSha256: plan.candidateSha256, kind: 'content',
      approvalReference: 'fictional test content approval ' + plan.planId,
      now: new Date('2026-10-20T00:00:00.000Z'),
    });
    await updateDraftStatus({ draftsDir: context.draftsDir, contentDir: context.contentDir, slug: fixture.draftId, workflowStatus: 'Approved', confirmedByUser: true });
    await assert.rejects(
      materializePublication({ draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: '0'.repeat(64) }),
      /candidate SHA-256.*一致/,
    );
    await assert.rejects(
      materializePublication({ draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 }),
      /GitHub公開承認記録/,
    );
    await recordCandidateApproval({
      draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId,
      candidateSha256: plan.candidateSha256, kind: 'github-publication',
      approvalReference: 'fictional test publication approval ' + plan.planId,
      authorizedActions: ['materialize', 'stage', 'commit', 'push', 'workflow_dispatch'],
      now: new Date('2026-10-20T00:01:00.000Z'),
    });
    const dryRunCli = runPublicationCli(['materialize', plan.planId, '--candidate-sha', plan.candidateSha256, '--dry-run'], context);
    assert.equal(dryRunCli.status, 0, dryRunCli.stderr);
    const dryRun = JSON.parse(dryRunCli.stdout);
    assert.equal(dryRun.dryRun, true);
    assert.equal(await lstat(path.join(context.contentDir, 'creative')).then(() => true, () => false), false);

    const result = await materializePublication({
      draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir,
      planId: plan.planId, candidateSha256: plan.candidateSha256,
    });
    assert.equal(result.alreadyMaterialized, false);
    const target = path.join(context.contentDir, 'creative', fixtureSlug);
    const publicArticle = path.join(target, 'index.md');
    const publicData = matter(await readFile(publicArticle, 'utf8'));
    assert.equal(publicData.data.draft, false);
    assert.ok(!Object.hasOwn(publicData.data, 'workflowStatus'));
    assert.equal(publicData.content, originalBody);
    assert.equal((await validateArticleFile(publicArticle)).issues.length, 0);
    assert.deepEqual((await collectFiles(target)).sort(), ['index.md', 'phase2b-public-body.png', 'phase2b-public-cover.png', 'phase2b-public-og.png']);

    const privateDraft = matter(await readFile(fixture.articlePath, 'utf8'));
    assert.equal(privateDraft.data.workflowStatus, 'Approved');
    assert.equal(privateDraft.data.draft, true);
    assert.equal(privateDraft.content, originalBody);
    assert.deepEqual(await readFile(path.join(fixture.directory, 'phase2b-public-cover.png')), privateCoverBefore);
    assert.deepEqual(await readFile(path.join(backup.path, 'index.md')), backupIndexBefore);
    assert.deepEqual(await readFile(path.join(backup.path, 'brief.md')), backupBriefBefore);

    const materializedBeforeRetry = await readFile(publicArticle);
    const repeated = await materializePublication({
      draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir,
      planId: plan.planId, candidateSha256: plan.candidateSha256,
    });
    assert.equal(repeated.alreadyMaterialized, true);
    assert.deepEqual(await readFile(publicArticle), materializedBeforeRetry);
  });
});

test('candidate approvals are separate, hash-bound, file-bound, date-bound, and action-scoped', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const plan = await prepareFixture(context, fixture);
    const common = { draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId };
    await assert.rejects(
      recordCandidateApproval({
        ...common, candidateSha256: '0'.repeat(64), kind: 'content',
        approvalReference: 'fictional test content approval',
      }),
      /候補SHA-256/,
    );
    await recordCandidateApproval({
      ...common, candidateSha256: plan.candidateSha256, kind: 'content',
      approvalReference: 'fictional test content approval',
      now: new Date('2026-10-20T00:00:00.000Z'),
    });
    await updateDraftStatus({ draftsDir: context.draftsDir, contentDir: context.contentDir, slug: fixture.draftId, workflowStatus: 'Approved', confirmedByUser: true });
    await assert.rejects(
      verifyCandidateApproval({ ...common, candidateSha256: plan.candidateSha256, action: 'materialize' }),
      /GitHub公開承認記録/,
    );
    await recordCandidateApproval({
      ...common, candidateSha256: plan.candidateSha256, kind: 'github-publication',
      approvalReference: 'fictional test publication approval',
      authorizedActions: ['materialize'],
      now: new Date('2026-10-20T00:01:00.000Z'),
    });
    const verified = await verifyCandidateApproval({ ...common, candidateSha256: plan.candidateSha256, action: 'materialize' });
    assert.deepEqual(verified.targetFiles, JSON.parse(await readFile(path.join(context.plansDir, plan.planId, 'plan.json'), 'utf8')).candidate.targetFiles);
    await assert.rejects(
      verifyCandidateApproval({ ...common, candidateSha256: plan.candidateSha256, action: 'push' }),
      /GitHub公開承認記録/,
    );

    const receiptPath = path.join(context.plansDir, plan.planId, 'github-publication-approval.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    const originalReceipt = structuredClone(receipt);
    receipt.candidate.targetFiles = ['creative/other/index.md'];
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await assert.rejects(
      verifyCandidateApproval({ ...common, candidateSha256: plan.candidateSha256, action: 'materialize' }),
      /GitHub公開承認記録/,
    );
    Object.assign(receipt, originalReceipt);
    receipt.candidate.id = 'publication-tampered';
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await assert.rejects(
      verifyCandidateApproval({ ...common, candidateSha256: plan.candidateSha256, action: 'materialize' }),
      /GitHub公開承認記録/,
    );
    Object.assign(receipt, originalReceipt);
    receipt.candidate.publishDate = '2026-10-20';
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await assert.rejects(
      verifyCandidateApproval({ ...common, candidateSha256: plan.candidateSha256, action: 'materialize' }),
      /GitHub公開承認記録/,
    );
  });

  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const plan = await prepareFixture(context, fixture);
    const common = { draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 };
    await updateDraftStatus({ draftsDir: context.draftsDir, contentDir: context.contentDir, slug: fixture.draftId, workflowStatus: 'Approved', confirmedByUser: true });
    await recordCandidateApproval({
      ...common, kind: 'github-publication', approvalReference: 'fictional test publication approval',
      authorizedActions: ['materialize'],
    });
    await assert.rejects(
      verifyCandidateApproval({ ...common, action: 'materialize' }),
      /内容承認記録/,
    );
  });
});

test('approval CLI records and checks separate fictional receipts in an isolated workspace', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const plan = await prepareFixture(context, fixture);
    const content = runPublicationCli([
      'record-approval', plan.planId, '--kind', 'content',
      '--candidate-sha', plan.candidateSha256,
      '--approval-reference', 'fictional CLI content approval fixture',
    ], context);
    assert.equal(content.status, 0, content.stderr);
    assert.match(content.stdout, /conversation-content-approval\.json/);

    await updateDraftStatus({ draftsDir: context.draftsDir, contentDir: context.contentDir, slug: fixture.draftId, workflowStatus: 'Approved', confirmedByUser: true });
    const publication = runPublicationCli([
      'record-approval', plan.planId, '--kind', 'github-publication',
      '--candidate-sha', plan.candidateSha256,
      '--approval-reference', 'fictional CLI publication approval fixture',
      '--authorized-actions', 'materialize,stage,commit,push,workflow_dispatch',
    ], context);
    assert.equal(publication.status, 0, publication.stderr);
    assert.match(publication.stdout, /github-publication-approval\.json/);

    const checked = runPublicationCli([
      'check-approval', plan.planId, '--candidate-sha', plan.candidateSha256,
      '--action', 'workflow_dispatch',
    ], context);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /workflow_dispatch/);
    assert.match(publication.stdout, /暗号学的な本人認証ではありません/);
  });
});

test('approval receipts are atomic, no-replace, retryable, and fail closed', async (t) => {
  await t.test('partial write and interruption never create an approval; retry succeeds', async () => {
    await withWorkspace(async (context) => {
      const fixture = await createReviewFixture(context);
      const plan = await prepareFixture(context, fixture);
      const common = { draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 };
      const planDirectory = path.join(context.plansDir, plan.planId);
      await assert.rejects(
        recordCandidateApproval({
          ...common, kind: 'content', approvalReference: 'fictional interrupted receipt fixture',
          receiptIo: {
            writeTemporary: async (handle, bytes) => {
              await handle.writeFile(bytes.subarray(0, Math.min(13, bytes.length)));
              throw new Error('fictional partial write interruption');
            },
          },
        }),
        /fictional partial write interruption/,
      );
      assert.equal(await readFile(path.join(planDirectory, 'content-seo-approval.json')).then(() => true, () => false), false);
      assert.equal((await readdir(planDirectory)).some((name) => name.endsWith('.tmp')), false);

      // Simulate a process crash that left a temp file. Exact receipt readers
      // ignore it, and a fresh attempt uses a unique temp name.
      await writeFile(path.join(planDirectory, '.conversation-content-approval.json.abandoned.tmp'), '{"partial":');
      const retried = await recordCandidateApproval({
        ...common, kind: 'content', approvalReference: 'fictional interrupted receipt fixture',
      });
      assert.equal(retried.alreadyRecorded, false);
      assert.ok((await readdir(planDirectory)).includes('.conversation-content-approval.json.abandoned.tmp'));
      await updateDraftStatus({
        draftsDir: context.draftsDir, contentDir: context.contentDir, slug: fixture.draftId,
        workflowStatus: 'Approved', confirmedByUser: true,
      });
      await recordCandidateApproval({
        ...common, kind: 'github-publication', approvalReference: 'fictional retry publication fixture',
        authorizedActions: ['materialize', 'stage', 'commit'],
      });
      await verifyCandidateApproval({ ...common, action: 'commit' });
      const repeated = await recordCandidateApproval({
        ...common, kind: 'content', approvalReference: 'fictional interrupted receipt fixture',
      });
      assert.equal(repeated.alreadyRecorded, true);
      await assert.rejects(
        recordCandidateApproval({
          ...common, kind: 'content', approvalReference: 'different fictional approval intent',
        }),
        /内容承認記録が不一致/,
      );
    });
  });

  await t.test('corrupt or symlink receipt is never replaced', async () => {
    await withWorkspace(async (context) => {
      const fixture = await createReviewFixture(context);
      const plan = await prepareFixture(context, fixture);
      const common = { draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 };
      const planDirectory = path.join(context.plansDir, plan.planId);
      const receiptPath = path.join(planDirectory, 'conversation-content-approval.json');
      await writeFile(receiptPath, '{"incomplete":');
      await assert.rejects(
        recordCandidateApproval({ ...common, kind: 'content', approvalReference: 'fictional corrupt receipt fixture' }),
        /JSONとして読み取れません/,
      );
      assert.equal(await readFile(receiptPath, 'utf8'), '{"incomplete":');

      await rm(receiptPath);
      const symlinkTarget = path.join(context.root, 'receipt-target.json');
      await writeFile(symlinkTarget, '{"foreign":"fixture"}');
      await symlink(symlinkTarget, receiptPath);
      await assert.rejects(
        recordCandidateApproval({ ...common, kind: 'content', approvalReference: 'fictional symlink receipt fixture' }),
        /通常ファイル以外/,
      );
      assert.equal(await readFile(symlinkTarget, 'utf8'), '{"foreign":"fixture"}');
    });
  });

  await t.test('plan-directory replacement during receipt creation fails closed and can be retried', async () => {
    await withWorkspace(async (context) => {
      const fixture = await createReviewFixture(context);
      const plan = await prepareFixture(context, fixture);
      const common = { draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 };
      const planDirectory = path.join(context.plansDir, plan.planId);
      const movedDirectory = planDirectory + '-moved-fixture';
      let replaced = false;
      await assert.rejects(
        recordCandidateApproval({
          ...common, kind: 'content', approvalReference: 'fictional path replacement fixture',
          receiptIo: {
            beforeLink: async (_temporaryPath, finalPath) => {
              if (replaced || !finalPath.endsWith('conversation-content-approval.json')) return;
              replaced = true;
              await rename(planDirectory, movedDirectory);
              await mkdir(planDirectory, { mode: 0o700 });
            },
          },
        }),
        /ENOENT/,
      );
      const finalReceipt = path.join(planDirectory, 'conversation-content-approval.json');
      assert.equal(await readFile(finalReceipt).then(() => true, () => false), false);
      await rm(planDirectory, { recursive: true, force: true });
      await rename(movedDirectory, planDirectory);

      const retried = await recordCandidateApproval({
        ...common, kind: 'content', approvalReference: 'fictional path replacement fixture',
      });
      assert.equal(retried.alreadyRecorded, false);
      assert.ok(await readFile(finalReceipt, 'utf8'));
    });
  });

  await t.test('concurrent identical writers converge; different approval intent is rejected', async () => {
    await withWorkspace(async (context) => {
      const fixture = await createReviewFixture(context);
      const plan = await prepareFixture(context, fixture);
      const common = { draftsDir: context.draftsDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 };
      const sameWrites = await Promise.all([
        recordCandidateApproval({
          ...common, kind: 'content', approvalReference: 'fictional concurrent identical fixture',
          now: new Date('2026-10-20T01:00:00.000Z'),
        }),
        recordCandidateApproval({
          ...common, kind: 'content', approvalReference: 'fictional concurrent identical fixture',
          now: new Date('2026-10-20T01:00:01.000Z'),
        }),
      ]);
      assert.equal(sameWrites.length, 2);
      const planDirectory = path.join(context.plansDir, plan.planId);
      assert.equal((await readdir(planDirectory)).some((name) => name.endsWith('.tmp')), false);

      const competing = await Promise.allSettled([
        recordCandidateApproval({
          ...common, kind: 'github-publication', approvalReference: 'fictional concurrent publish A',
          authorizedActions: ['stage', 'commit'],
        }),
        recordCandidateApproval({
          ...common, kind: 'github-publication', approvalReference: 'fictional concurrent publish B',
          authorizedActions: ['stage', 'commit', 'push'],
        }),
      ]);
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(competing.filter((result) => result.status === 'rejected').length, 1);
    });
  });
});

test('Git scope gate checks exact index blobs and the post-commit tree in isolated fictional repositories', async (t) => {
  await t.test('exact candidate index passes read-only and commit checks; parent mismatch fails', async () => {
    await withWorkspace(async (context) => {
      const scenario = await createGitScopeScenario(context);
      const wrongCandidateSha = checkGitScope(context, scenario, 'index', '0'.repeat(64));
      assert.notEqual(wrongCandidateSha.status, 0);
      assert.match(wrongCandidateSha.stderr, /指定candidate SHA-256/);
      runFixtureGit(context.root, ['add', '--', ...scenario.repoPaths]);
      const before = runFixtureGit(context.root, ['diff', '--cached', '--name-status', '-z', '--find-renames']);
      const indexResult = checkGitScope(context, scenario, 'index');
      assert.equal(indexResult.status, 0, indexResult.stderr);
      assert.match(indexResult.stdout, /"readOnly": true/);
      assert.deepEqual(runFixtureGit(context.root, ['diff', '--cached', '--name-status', '-z', '--find-renames']), before);

      runFixtureGit(context.root, ['commit', '-m', 'fictional candidate publication']);
      const commitResult = checkGitScope(context, scenario, 'commit');
      assert.equal(commitResult.status, 0, commitResult.stderr);
      assert.match(commitResult.stdout, /"parentSha"/);
      await writeFile(path.join(context.root, 'later-staged-fixture.txt'), 'fictional later staging\n');
      runFixtureGit(context.root, ['add', '--', 'later-staged-fixture.txt']);
      const leftoverStage = checkGitScope(context, scenario, 'commit');
      assert.notEqual(leftoverStage.status, 0);
      assert.match(leftoverStage.stderr, /commit後に別のステージ済み変更/);
      const current = runFixtureGit(context.root, ['rev-parse', 'HEAD']).trim();
      runFixtureGit(context.root, ['update-ref', 'refs/remotes/origin/main', current]);
      const wrongParent = checkGitScope(context, scenario, 'commit');
      assert.notEqual(wrongParent.status, 0);
      assert.match(wrongParent.stderr, /親が確認済みorigin\/mainと一致しません/);
    });
  });

  await t.test('missing and extra staged paths are rejected', async () => {
    await withWorkspace(async (context) => {
      const missing = await createGitScopeScenario(context);
      runFixtureGit(context.root, ['add', '--', missing.repoPaths[0]]);
      const missingResult = checkGitScope(context, missing);
      assert.notEqual(missingResult.status, 0);
      assert.match(missingResult.stderr, /候補ファイルが欠落/);
    });
    await withWorkspace(async (context) => {
      const extra = await createGitScopeScenario(context);
      await writeFile(path.join(context.root, 'unrelated-fixture.txt'), 'not in candidate\\n');
      runFixtureGit(context.root, ['add', '--', ...extra.repoPaths, 'unrelated-fixture.txt']);
      const extraResult = checkGitScope(context, extra);
      assert.notEqual(extraResult.status, 0);
      assert.match(extraResult.stderr, /allowlist外/);
    });
  });

  await t.test('staged content hash mismatch and non-add status are rejected', async () => {
    await withWorkspace(async (context) => {
      const changed = await createGitScopeScenario(context);
      const articlePath = path.join(context.root, changed.repoPaths.find((value) => value.endsWith('/index.md')));
      await writeFile(articlePath, (await readFile(articlePath, 'utf8')) + '\\nTampered fixture bytes.\\n');
      runFixtureGit(context.root, ['add', '--', ...changed.repoPaths]);
      const changedResult = checkGitScope(context, changed);
      assert.notEqual(changedResult.status, 0);
      assert.match(changedResult.stderr, /SHA-256が保存payloadと一致しません/);
    });
    await withWorkspace(async (context) => {
      const committed = await createGitScopeScenario(context);
      const articlePath = path.join(context.root, committed.repoPaths.find((value) => value.endsWith('/index.md')));
      await writeFile(articlePath, (await readFile(articlePath, 'utf8')) + '\nChanged only in fictional commit tree.\n');
      runFixtureGit(context.root, ['add', '--', ...committed.repoPaths]);
      runFixtureGit(context.root, ['commit', '-m', 'fictional altered candidate blob']);
      const result = checkGitScope(context, committed, 'commit');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /commit tree の候補ファイルSHA-256が保存payloadと一致しません/);
    });
    await withWorkspace(async (context) => {
      const modified = await createGitScopeScenario(context, { candidateInBase: true });
      const articlePath = path.join(context.root, modified.repoPaths.find((value) => value.endsWith('/index.md')));
      await writeFile(articlePath, (await readFile(articlePath, 'utf8')) + '\\nModified fixture bytes.\\n');
      runFixtureGit(context.root, ['add', '--', ...modified.repoPaths]);
      const modifiedResult = checkGitScope(context, modified);
      assert.notEqual(modifiedResult.status, 0);
      assert.match(modifiedResult.stderr, /変更種別が新規追加Aではありません: M/);
    });
  });

  await t.test('delete, rename, symlink, and post-commit extra file are rejected', async () => {
    await withWorkspace(async (context) => {
      const deleted = await createGitScopeScenario(context, { candidateInBase: true });
      runFixtureGit(context.root, ['rm', '--', deleted.repoPaths[0]]);
      const result = checkGitScope(context, deleted);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /変更種別が新規追加Aではありません: D/);
    });
    await withWorkspace(async (context) => {
      const renamed = await createGitScopeScenario(context, { candidateInBase: true });
      const oldPath = renamed.repoPaths.find((value) => value.endsWith('/phase2b-public-cover.png'));
      runFixtureGit(context.root, ['mv', '--', oldPath, oldPath.replace('phase2b-public-cover.png', 'phase2b-renamed-cover.png')]);
      const result = checkGitScope(context, renamed);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /rename\/copy/);
    });
    await withWorkspace(async (context) => {
      const linked = await createGitScopeScenario(context);
      const imagePath = path.join(context.root, linked.repoPaths.find((value) => value.endsWith('/phase2b-public-cover.png')));
      const linkedPath = linked.repoPaths.find((value) => value.endsWith('/phase2b-public-cover.png'));
      const target = path.join(context.root, 'README.md');
      await rm(imagePath);
      await symlink(target, imagePath);
      runFixtureGit(context.root, ['add', '--', ...linked.repoPaths]);
      const result = checkGitScope(context, linked);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /通常の非実行ファイルではありません/);
    });
    await withWorkspace(async (context) => {
      const committed = await createGitScopeScenario(context);
      await writeFile(path.join(context.root, 'unrelated-committed-fixture.txt'), 'outside candidate\\n');
      runFixtureGit(context.root, ['add', '--', ...committed.repoPaths, 'unrelated-committed-fixture.txt']);
      runFixtureGit(context.root, ['commit', '-m', 'fictional out-of-scope commit']);
      const result = checkGitScope(context, committed, 'commit');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /allowlist外/);
    });
  });
});

test('rejects a publication plan whose review label no longer matches its exact article payload', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const plan = await prepareFixture(context, fixture);
    const planFile = path.join(context.plansDir, plan.planId, 'plan.json');
    const manifest = JSON.parse(await readFile(planFile, 'utf8'));
    manifest.candidate.title = '別のタイトル';
    await writeFile(planFile, JSON.stringify(manifest, null, 2) + '\n');
    await assert.rejects(
      materializePublication({ draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 }),
      /表示情報がpayloadと一致しません/,
    );
  });
});

test('blocks an unresolved brief marker before creating a private publication plan', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    await writeFile(fixture.briefPath, '# 確認待ち\n\n開催日と会場が未確認です。\n');
    await assert.rejects(prepareFixture(context, fixture), /未確認・要確認の事実が残っています/);
    assert.equal(await lstat(context.plansDir).then(() => true, () => false), false);
    assert.ok(await lstat(fixture.articlePath));
  });
});

test('refuses duplicate slugs, unsafe images, and stale candidate content', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const duplicateDirectory = path.join(context.contentDir, 'creative', 'existing-duplicate');
    await mkdir(duplicateDirectory, { recursive: true });
    await writeFile(path.join(duplicateDirectory, 'index.md'), matter.stringify('fixture', {
      title: '別の架空記事', slug: fixtureSlug, description: '公開候補のslug重複を検出するためのテスト用説明文です。実在の内容はありません。',
      pubDate: '2026-10-19', category: 'Creative', draft: false,
    }));
    await assert.rejects(prepareFixture(context, fixture), /slug が既存記事/);
  });

  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const parsed = matter(await readFile(fixture.articlePath, 'utf8'));
    await writeFile(fixture.articlePath, matter.stringify(parsed.content + '\n[壊れた内部リンク](/blog/posts/not-published/)\n', parsed.data));
    await assert.rejects(prepareFixture(context, fixture), /ブログ内リンクの公開先を確認できません/);
  });

  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const outside = path.join(context.root, 'outside.svg');
    await writeFile(outside, svg('#aabbcc'));
    await symlink(outside, path.join(fixture.directory, 'linked.svg'));
    const parsed = matter(await readFile(fixture.articlePath, 'utf8'));
    await writeFile(fixture.articlePath, matter.stringify(parsed.content, { ...parsed.data, cover: './linked.svg' }));
    const before = await readFile(fixture.articlePath);
    await assert.rejects(prepareFixture(context, fixture), /通常ファイル|シンボリックリンク/);
    assert.deepEqual(await readFile(fixture.articlePath), before);
  });

  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const plan = await prepareFixture(context, fixture);
    await approveFixture(context, fixture, plan);
    const parsed = matter(await readFile(fixture.articlePath, 'utf8'));
    await writeFile(fixture.articlePath, matter.stringify(parsed.content + '\n追加された未承認の変更です。\n', parsed.data));
    await assert.rejects(
      materializePublication({ draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir, planId: plan.planId, candidateSha256: plan.candidateSha256 }),
      /下書き内容が変わっています/,
    );
    assert.equal(await lstat(path.join(context.contentDir, 'creative', fixtureSlug)).then(() => true, () => false), false);
  });
});

test('resumes an interrupted local placement without replacing files or losing the private backup', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const backup = await backupDraft({ draftsDir: context.draftsDir, backupsDir: context.backupsDir, draftId: fixture.draftId });
    const backupIndex = await readFile(path.join(backup.path, 'index.md'));
    const plan = await prepareFixture(context, fixture);
    await approveFixture(context, fixture, plan);
    await assert.rejects(
      materializePublication({
        draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir,
        planId: plan.planId, candidateSha256: plan.candidateSha256,
        linkFile: async (source, target) => {
          if (path.basename(target) === 'index.md') throw new Error('injected interrupted write');
          return link(source, target);
        },
      }),
      /ローカル配置が未完了/,
    );
    const target = path.join(context.contentDir, 'creative', fixtureSlug);
    assert.ok(JSON.parse(await readFile(path.join(target, '.publication-in-progress.json'), 'utf8')));
    assert.equal(await lstat(path.join(target, 'index.md')).then(() => true, () => false), false);
    const resumed = await materializePublication({
      draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir,
      planId: plan.planId, candidateSha256: plan.candidateSha256,
    });
    assert.equal(resumed.alreadyMaterialized, false);
    assert.equal(await lstat(path.join(target, '.publication-in-progress.json')).then(() => true, () => false), false);
    assert.ok(await lstat(path.join(target, 'index.md')));
    assert.deepEqual(await readFile(path.join(backup.path, 'index.md')), backupIndex);
  });
});

test('verifies the live URL, category, cover, SEO and deployment SHA before recording the result', async () => {
  await withWorkspace(async (context) => {
    const fixture = await createReviewFixture(context);
    const plan = await prepareFixture(context, fixture);
    const candidate = JSON.parse(await readFile(path.join(context.plansDir, plan.planId, 'plan.json'), 'utf8')).candidate;
    const commitSha = 'a'.repeat(40);
    const requested = [];
    const fakeFetch = async (url) => {
      requested.push(String(url));
      const responseBody = String(url) === candidate.publicUrl
        ? `<html><head><title>${candidate.seoTitle}｜Mizuki Oyama Journal</title><link rel="canonical" href="${candidate.publicUrl}"><meta property="og:title" content="${candidate.seoTitle}｜Mizuki Oyama Journal"><meta property="og:description" content="${candidate.metaDescription}"><meta property="og:image" content="/blog/og-image.png"><meta property="og:image:alt" content="OGP画像"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="/blog/og-image.png"><meta name="twitter:image:alt" content="OGP画像"></head><body><h1>${candidate.title}</h1><h2>架空の制作記録</h2><figure class="article-cover"><img src="/blog/_astro/phase2b-cover.svg" alt="${candidate.coverAlt}"></figure></body></html>`
        : String(url).includes('/categories/')
          ? `<a href="/blog/posts/${candidate.slug}/">${candidate.title}</a>`
          : 'image';
      return { status: 200, text: async () => responseBody };
    };
    await assert.rejects(verifyLivePublication({
      plansDir: context.plansDir, planId: plan.planId, commitSha,
      workflowSha: 'b'.repeat(40), workflowRunUrl: 'https://github.com/mizukioyama/blog/actions/runs/123',
      buildStatus: 'success', deployStatus: 'success', fetchImpl: fakeFetch,
    }), /SHAが一致しません/);
    assert.equal(requested.length, 0);
    const result = await verifyLivePublication({
      plansDir: context.plansDir, planId: plan.planId, commitSha, workflowSha: commitSha,
      workflowRunUrl: 'https://github.com/mizukioyama/blog/actions/runs/123',
      buildStatus: 'success', deployStatus: 'success', fetchImpl: fakeFetch,
      now: new Date('2026-10-19T03:00:00.000Z'),
    });
    assert.equal(result.commitSha, commitSha);
    assert.equal(result.checks.categoryListing, 'PASS');
    assert.equal(result.checks.browserResponsiveAndConsole, 'NOT_TESTED');
    assert.deepEqual(requested, [
      candidate.publicUrl,
      'https://mizukioyama.github.io/blog/categories/creative/',
      'https://mizukioyama.github.io/blog/_astro/phase2b-cover.svg',
      'https://mizukioyama.github.io/blog/og-image.png',
    ]);
    const record = JSON.parse(await readFile(path.join(context.plansDir, plan.planId, 'publication-result.json'), 'utf8'));
    assert.deepEqual(record.analyticsReviewWindows, ['12h', '24h']);
  });
});

test('builds a materialized fictional article in an isolated Astro project while retaining the private draft', async () => {
  const root = await createBuildWorkspace();
  try {
    const context = {
      root,
      draftsDir: path.join(root, '.private-drafts'),
      backupsDir: path.join(root, '.private-draft-backups'),
      contentDir: path.join(root, 'src/content/blog'),
      plansDir: path.join(root, '.private-publication'),
      publicDir: path.join(root, 'public'),
    };
    const fixture = await createReviewFixture(context, { slug: fixtureSlug });
    const privateMarker = privateDraftIdSentinel;
    await mkdir(path.join(context.draftsDir, privateMarker), { recursive: true });
    const privateImageNames = ['phase2b-private-cover-8391.svg', 'phase2b-private-og-8391.svg', 'phase2b-private-body-8391.svg'];
    await Promise.all(privateImageNames.map((name, index) => writeFile(path.join(context.draftsDir, privateMarker, name), svg(['#fe3911', '#e82192', '#a211e9'][index]))));
    const draftArticle = matter.stringify('## 非公開fixture\n\nPHASE2B_PRIVATE_BUILD_SENTINEL_0f33。'.repeat(10), {
      title: 'PHASE2B_PRIVATE_TITLE_SENTINEL_0f33', slug: 'phase2b-private-build-fixture',
      description: '本番ビルドが非公開fixtureを除外することを確認するためだけの説明文です。実際の記事ではありません。',
      pubDate: '2026-10-19', category: 'Creative', draft: true, workflowStatus: 'Review',
      cover: './' + privateImageNames[0], coverAlt: '非公開fixtureの画像',
      ogImage: './' + privateImageNames[1], ogImageAlt: '非公開fixtureのOGP',
    });
    await writeFile(path.join(context.draftsDir, privateMarker, 'index.md'), draftArticle);
    const plan = await prepareFixture(context, fixture);
    await approveFixture(context, fixture, plan);
    await materializePublication({
      draftsDir: context.draftsDir, contentDir: context.contentDir, plansDir: context.plansDir,
      planId: plan.planId, candidateSha256: plan.candidateSha256,
    });

    const build = spawnSync('npm', ['run', 'build'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'development', BLOG_LOAD_LOCAL_DRAFTS: '1', ASTRO_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout || 'isolated Astro build failed');
    const dist = path.join(root, 'dist');
    const outputFiles = await walkFiles(dist);
    assert.ok(outputFiles.includes(`posts/${fixtureSlug}/index.html`));
    assert.ok(outputFiles.includes(`categories/creative/index.html`));
    assert.ok(outputFiles.includes('posts/yurayura-first-group-exhibition-report/index.html'));
    assert.equal(outputFiles.some((file) => file.startsWith('draft-preview/')), false);
    const privateSentinels = [privateMarker, 'phase2b-private-build-fixture', 'PHASE2B_PRIVATE_TITLE_SENTINEL_0f33', 'PHASE2B_PRIVATE_BUILD_SENTINEL_0f33', ...privateImageNames, '#fe3911', '#e82192', '#a211e9'];
    for (const file of outputFiles) {
      const artifact = await readFile(path.join(dist, file));
      for (const sentinel of privateSentinels) assert.equal(artifact.includes(Buffer.from(sentinel)), false, `private sentinel leaked in ${file}`);
    }
    const publicHtml = await readFile(path.join(dist, 'posts', fixtureSlug, 'index.html'), 'utf8');
    assert.match(publicHtml, new RegExp(fixtureTitle));
    assert.match(publicHtml, /twitter:image/);
    assert.match(await readFile(path.join(dist, 'categories/creative/index.html'), 'utf8'), new RegExp(fixtureSlug));
    const allOutput = (await Promise.all(outputFiles.filter((file) => /\.html?$/.test(file)).map((file) => readFile(path.join(dist, file), 'utf8')))).join('\n');
    assert.doesNotMatch(allOutput, /PHASE2B_PRIVATE_(?:TITLE|BUILD)_SENTINEL/);
    assert.ok((await lstat(path.join(context.draftsDir, fixture.draftId, 'index.md'))).isFile());
    assert.equal(matter(await readFile(fixture.articlePath, 'utf8')).data.workflowStatus, 'Approved');
    assert.ok(await lstat(path.join(context.draftsDir, privateMarker, 'index.md')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
