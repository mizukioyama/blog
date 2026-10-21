import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { createDraft, saveDraftArticle, updateDraftStatus } from '../scripts/article-workflow.mjs';
import { materializePublication, preparePublication, recordCandidateApproval } from '../scripts/article-publication.mjs';
import { validateContentWorkspace } from '../scripts/validate-content.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const slug = 'phase2f-approved-publication-fixture';
const title = '承認済み記事の対応を検証する架空記事';
const imageNames = ['fixture-cover.png', 'fixture-og.png', 'fixture-body.png'];

function article(overrides = {}) {
  const data = {
    title,
    seoTitle: title,
    slug,
    description: 'これは公開記事と非公開下書きのSlug対応を検証する架空の説明文です。実在の人物、体験、展示、作品、開催情報は含みません。',
    pubDate: '2026-10-19',
    category: 'Creative',
    tags: ['phase2f-fixture'],
    cover: './fixture-cover.png',
    coverAlt: '隔離テスト用カバー。',
    ogImage: './fixture-og.png',
    ogImageAlt: '隔離テスト用OGP画像。',
    ...overrides,
  };
  const content = '## 隔離された検証記事\n\n' +
    '公開候補と非公開下書きの対応をテスト専用フォルダーで確認します。'.repeat(10) +
    '\n\n![テスト用本文画像](./fixture-body.png)\n';
  return { data, content, brief: '# 隔離テスト\n\n架空fixtureです。確認事項はありません。\n' };
}

async function workspace(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-phase2f-validation-'));
  const context = {
    root,
    draftsDir: path.join(root, '.private-drafts'),
    backupsDir: path.join(root, '.private-draft-backups'),
    contentDir: path.join(root, 'src/content/blog'),
    plansDir: path.join(root, '.private-publication'),
    publicDir: path.join(root, 'public'),
  };
  await Promise.all([
    mkdir(context.draftsDir, { recursive: true }),
    mkdir(context.backupsDir, { recursive: true }),
    mkdir(context.contentDir, { recursive: true }),
    mkdir(context.publicDir, { recursive: true }),
  ]);
  await writeFile(path.join(context.publicDir, 'og-image.png'), Buffer.from('fixture site OGP'));
  try { await run(context); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function createFixture(context, {
  now = new Date('2026-10-19T00:00:00.000Z'),
  workflowStatus = 'Review',
  articleSlug = slug,
  articleTitle = title,
} = {}) {
  const created = await createDraft({
    draftsDir: context.draftsDir,
    topic: '架空の公開記事検証',
    category: 'Creative',
    now,
  });
  const image = await readFile(path.join(repoRoot, 'public/og-image.png'));
  await Promise.all(imageNames.map((name) => writeFile(path.join(created.directory, name), image)));
  const fixture = article({ slug: articleSlug, title: articleTitle, seoTitle: articleTitle });
  await saveDraftArticle({
    draftsDir: context.draftsDir,
    contentDir: context.contentDir,
    draftId: created.draftId,
    ...fixture,
  });
  await updateDraftStatus({
    draftsDir: context.draftsDir,
    contentDir: context.contentDir,
    slug: created.draftId,
    workflowStatus: 'Review',
  });
  if (workflowStatus !== 'Review') {
    await updateDraftStatus({
      draftsDir: context.draftsDir,
      contentDir: context.contentDir,
      slug: created.draftId,
      workflowStatus,
      confirmedByUser: workflowStatus === 'Approved',
    });
  }
  return { ...created, ...fixture, draftId: created.draftId };
}

async function materialize(context, fixture) {
  const plan = await preparePublication({
    draftsDir: context.draftsDir,
    contentDir: context.contentDir,
    plansDir: context.plansDir,
    backupsDir: context.backupsDir,
    publicOgImage: path.join(context.publicDir, 'og-image.png'),
    draftId: fixture.draftId,
    now: new Date('2026-10-19T01:02:03.000Z'),
  });
  const approval = {
    draftsDir: context.draftsDir,
    plansDir: context.plansDir,
    planId: plan.planId,
    candidateSha256: plan.candidateSha256,
  };
  await recordCandidateApproval({
    ...approval, kind: 'content',
    approvalReference: 'fictional content approval fixture ' + plan.planId,
    now: new Date('2026-10-19T01:03:00.000Z'),
  });
  await updateDraftStatus({
    draftsDir: context.draftsDir,
    contentDir: context.contentDir,
    slug: fixture.draftId,
    workflowStatus: 'Approved',
    confirmedByUser: true,
  });
  await recordCandidateApproval({
    ...approval, kind: 'github-publication',
    approvalReference: 'fictional publication approval fixture ' + plan.planId,
    authorizedActions: ['materialize'],
    now: new Date('2026-10-19T01:04:00.000Z'),
  });
  await materializePublication({
    draftsDir: context.draftsDir,
    contentDir: context.contentDir,
    plansDir: context.plansDir,
    planId: plan.planId,
    candidateSha256: plan.candidateSha256,
  });
  return plan;
}

async function validate(context) {
  return validateContentWorkspace({
    publicRoot: context.contentDir,
    privateRoot: context.draftsDir,
    plansRoot: context.plansDir,
  });
}

async function manualPublicCopy(context, fixture) {
  const directory = path.join(context.contentDir, 'creative/manual-copy');
  await mkdir(directory, { recursive: true });
  for (const name of imageNames) await cp(path.join(fixture.directory, name), path.join(directory, name));
  const data = { ...fixture.data, draft: false };
  delete data.workflowStatus;
  await writeFile(path.join(directory, 'index.md'), matter.stringify(fixture.content, data));
  return directory;
}

const hasCollision = (result) => result.issues.some((issue) =>
  issue.includes('slug が既存記事または別の下書きと重複しています') ||
  issue.includes('slug が別の下書きと重複しています') ||
  issue.includes('slug が重複しています'));

test('validates an ordinary private Review draft without a public collision', async () => {
  await workspace(async (context) => {
    await createFixture(context);
    assert.deepEqual((await validate(context)).issues, []);
  });
});

test('allows an Approved draft only when candidate, approvals, source, payload, and public files match', async () => {
  await workspace(async (context) => {
    const fixture = await createFixture(context);
    await materialize(context, fixture);
    assert.deepEqual((await validate(context)).issues, []);
  });
});

test('rejects changed draft content or changed materialized images', async (t) => {
  await t.test('content', async () => workspace(async (context) => {
    const fixture = await createFixture(context);
    await materialize(context, fixture);
    const parsed = matter(await readFile(fixture.articlePath, 'utf8'));
    await writeFile(fixture.articlePath, matter.stringify(parsed.content + '\n追加変更。\n', parsed.data));
    assert.ok(hasCollision(await validate(context)));
  }));
  await t.test('brief', async () => workspace(async (context) => {
    const fixture = await createFixture(context);
    await materialize(context, fixture);
    await writeFile(path.join(fixture.directory, 'brief.md'), '# 変更されたfixture\n');
    assert.ok(hasCollision(await validate(context)));
  }));
  await t.test('image', async () => workspace(async (context) => {
    const fixture = await createFixture(context);
    const plan = await materialize(context, fixture);
    const manifest = JSON.parse(await readFile(path.join(context.plansDir, plan.planId, 'plan.json'), 'utf8'));
    const cover = manifest.candidate.cover.replace(/^\.\//, '');
    await writeFile(path.join(context.contentDir, manifest.candidate.targetDirectory, cover), Buffer.from('changed image'));
    assert.ok(hasCollision(await validate(context)));
  }));
  for (const imageName of imageNames) {
    await t.test(`source ${imageName}`, async () => workspace(async (context) => {
      const fixture = await createFixture(context);
      await materialize(context, fixture);
      await writeFile(path.join(fixture.directory, imageName), Buffer.from('changed draft image'));
      assert.ok(hasCollision(await validate(context)));
    }));
  }
});

test('rejects repeated private and public slugs', async (t) => {
  await t.test('second private draft', async () => workspace(async (context) => {
    const fixture = await createFixture(context);
    await materialize(context, fixture);
    const sourceDraft = path.join(context.draftsDir, fixture.draftId);
    const secondDraft = path.join(context.draftsDir, 'draft-phase2f-other-copy');
    await cp(sourceDraft, secondDraft, { recursive: true });
    const result = await validate(context);
    assert.ok(result.issues.some((issue) => issue.includes('別の下書きと重複')));
  }));
  await t.test('second public article', async () => workspace(async (context) => {
    const fixture = await createFixture(context);
    await materialize(context, fixture);
    const original = path.join(context.contentDir, 'creative', slug);
    const duplicate = path.join(context.contentDir, 'exhibition', 'duplicate-folder');
    await mkdir(path.dirname(duplicate), { recursive: true });
    await cp(original, duplicate, { recursive: true });
    assert.ok((await validate(context)).issues.some((issue) => issue.includes('slug が重複しています')));
  }));
});

test('rejects Draft and Review slug collisions with public content', async (t) => {
  for (const workflowStatus of ['Draft', 'Review']) {
    await t.test(workflowStatus, async () => workspace(async (context) => {
      const fixture = await createFixture(context, { workflowStatus });
      await manualPublicCopy(context, fixture);
      assert.ok(hasCollision(await validate(context)));
    }));
  }
});

test('rejects an Approved draft without a valid candidate and rejects candidate ID or hash tampering', async (t) => {
  await t.test('no candidate', async () => workspace(async (context) => {
    const fixture = await createFixture(context, { workflowStatus: 'Approved' });
    await manualPublicCopy(context, fixture);
    assert.ok(hasCollision(await validate(context)));
  }));
  for (const tamper of ['candidate ID', 'candidate hash']) {
    await t.test(tamper, async () => workspace(async (context) => {
      const fixture = await createFixture(context);
      const plan = await materialize(context, fixture);
      const file = path.join(context.plansDir, plan.planId, 'plan.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (tamper === 'candidate ID') manifest.planId = 'publication-tampered';
      else manifest.candidate.candidateSha256 = '0'.repeat(64);
      await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
      const result = await validate(context);
      assert.ok(hasCollision(result));
      assert.ok(result.issues.some((issue) => issue.includes('対応する承認候補を検証できません')));
    }));
  }
});
