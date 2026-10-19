import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const privateSlug = 'phase2a-private-leak-sentinel';
const privateId = 'draft-phase2a-private-leak-sentinel';
const privateTitle = 'PHASE2A_PRIVATE_TITLE_SENTINEL_7f23';
const privateBody = 'PHASE2A_PRIVATE_BODY_SENTINEL_9ac4';
const privateImageNames = [
  'phase2a-private-cover.png',
  'phase2a-private-og-image.png',
  'phase2a-private-body-image.png',
];
const contentDraftSlug = 'phase2a-content-draft-sentinel';
const contentDraftTitle = 'PHASE2A_CONTENT_DRAFT_TITLE_SENTINEL_814e';
const contentDraftBody = 'PHASE2A_CONTENT_DRAFT_BODY_SENTINEL_62bf';
const contentDraftImageNames = [
  'phase2a-content-draft-cover.png',
  'phase2a-content-draft-og-image.png',
  'phase2a-content-draft-body-image.png',
];
const globPrivateSlug = 'phase2a-glob-shadow-private';
const globPrivateTitle = 'PHASE2A_GLOB_SHADOW_TITLE_SENTINEL_b31d';
const globPrivateBody = 'PHASE2A_GLOB_SHADOW_BODY_SENTINEL_0fc2';
const globPublicSlug = 'phase2a-glob-literal-public';
const globPublicTitle = 'PHASE2A_GLOB_LITERAL_PUBLIC_SENTINEL_18e9';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function pngFixture([red, green, blue]) {
  const width = 2;
  const height = 2;
  const imageData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    imageData[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + x * 4;
      imageData[pixelStart] = red;
      imageData[pixelStart + 1] = green;
      imageData[pixelStart + 2] = blue;
      imageData[pixelStart + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(imageData)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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

async function createBuildWorkspace({ withPrivateDraft }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-private-build-isolation-'));
  for (const name of ['astro.config.mjs', 'package.json', 'tsconfig.json', 'src', 'public', 'scripts']) {
    await cp(path.join(repoRoot, name), path.join(root, name), { recursive: true });
  }
  await mkdir(path.join(root, '.private-drafts'), { recursive: true });
  await linkDependencies(root);

  if (withPrivateDraft) {
    const draftDirectory = path.join(root, '.private-drafts', privateId);
    await mkdir(draftDirectory, { recursive: true });
    const [cover, ogImage, bodyImage] = privateImageNames;
    await Promise.all([
      writeFile(path.join(draftDirectory, cover), pngFixture([211, 37, 72])),
      writeFile(path.join(draftDirectory, ogImage), pngFixture([41, 143, 77])),
      writeFile(path.join(draftDirectory, bodyImage), pngFixture([45, 79, 199])),
    ]);
    const frontmatter = [
      '---',
      'title: "' + privateTitle + '"',
      'slug: "' + privateSlug + '"',
      'description: "これは本番ビルドへの下書き混入を検出するための架空テスト記事です。実在の展示や人物に関する情報は含みません。"',
      'pubDate: "2026-10-19"',
      'category: "Creative"',
      'tags: ["phase2a-isolation-fixture"]',
      'draft: true',
      'workflowStatus: "Review"',
      'cover: "./' + cover + '"',
      'coverAlt: "隔離テスト用の架空カバー画像"',
      'ogImage: "./' + ogImage + '"',
      'ogImageAlt: "隔離テスト用の架空OGP画像"',
      '---',
      '',
      '## 隔離テスト',
      '',
      privateBody + '。この文章は非公開fixtureであり、本番ビルド成果物には現れてはいけません。',
      '',
      '![隔離テスト用本文画像](./' + bodyImage + ')',
      '',
      ('この段落は記事検証のために繰り返しています。公開記事ではなく、非公開下書きのビルド隔離確認だけに使用します。' +
        '\n\n').repeat(5),
    ].join('\n');
    await writeFile(path.join(draftDirectory, 'index.md'), frontmatter, { flag: 'wx' });

    const contentDirectory = path.join(root, 'src/content/blog', 'phase2a-content-draft-sentinel');
    await mkdir(contentDirectory, { recursive: true });
    const [contentCover, contentOgImage, contentBodyImage] = contentDraftImageNames;
    await Promise.all([
      writeFile(path.join(contentDirectory, contentCover), pngFixture([171, 33, 91])),
      writeFile(path.join(contentDirectory, contentOgImage), pngFixture([56, 132, 87])),
      writeFile(path.join(contentDirectory, contentBodyImage), pngFixture([52, 74, 191])),
    ]);
    const contentFrontmatter = [
      '---',
      'title: "' + contentDraftTitle + '"',
      'slug: "' + contentDraftSlug + '"',
      'description: "これは公開コンテンツフォルダー内の架空Review下書きが本番ビルドに混ざらないことを確認するテスト記事です。"',
      'pubDate: "2026-10-19"',
      'category: "Creative"',
      'tags: ["phase2a-content-draft-fixture"]',
      'draft: true',
      'cover: "./' + contentCover + '"',
      'coverAlt: "隔離テスト用のカバー画像"',
      'ogImage: "./' + contentOgImage + '"',
      'ogImageAlt: "隔離テスト用のOGP画像"',
      '---',
      '',
      '## 隔離テスト',
      '',
      contentDraftBody + '。この架空の内容は公開成果物へ出てはいけません。',
      '',
      '![隔離テスト用本文画像](./' + contentBodyImage + ')',
    ].join('\n');
    await writeFile(path.join(contentDirectory, 'index.md'), contentFrontmatter, { flag: 'wx' });

  }

  // Keep this published path in both clean and draft builds. Its brackets are
  // literal filename characters, not glob syntax for an adjacent draft file.
  const literalPublicPath = path.join(root, 'src/content/blog', 'phase2a-[ab]-literal-glob.md');
  const writeContentFixture = (slug, title, body, draft) => [
    '---',
    'title: "' + title + '"',
    'slug: "' + slug + '"',
    'description: "これはglob文字の完全一致を確認するための架空記事です。公開範囲の判定テストだけに使用します。"',
    'pubDate: "2026-10-19"',
    'category: "Creative"',
    'tags: ["phase2a-glob-pattern-fixture"]',
    'draft: ' + String(draft),
    '---',
    '',
    '## ファイル名の完全一致',
    '',
    body,
    '',
  ].join('\n');
  const publicBody = 'この文章は公開記事のファイル名に含まれる角括弧を文字どおり扱い、隣接する非公開記事を誤って読み込まないことを確認するための架空fixtureです。内容はテスト用途に限定しています。'.repeat(4);
  await writeFile(literalPublicPath, writeContentFixture(globPublicSlug, globPublicTitle, publicBody, false), { flag: 'wx' });
  if (withPrivateDraft) {
    const shadowDraftPath = path.join(root, 'src/content/blog', 'phase2a-a-literal-glob.md');
    await writeFile(shadowDraftPath, writeContentFixture(globPrivateSlug, globPrivateTitle, globPrivateBody, true), { flag: 'wx' });
  }

  return root;
}

async function runBuild(root, direct = false) {
  const executable = direct ? process.execPath : 'npm';
  const args = direct
    ? [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'build']
    : ['run', 'build'];
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', BLOG_LOAD_LOCAL_DRAFTS: '1', ASTRO_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || (direct ? 'direct Astro build failed' : 'npm production build failed'));
}

async function collectBuildFiles(root) {
  const outputRoot = path.join(root, 'dist');
  const files = new Map();
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryRelative = path.posix.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, entryRelative);
      else if (entry.isFile()) {
        const contents = await readFile(absolute);
        files.set(entryRelative, {
          sha256: createHash('sha256').update(contents).digest('hex'),
          contents,
        });
      }
    }
  }
  await visit(outputRoot);
  return files;
}

function assertPublicArticleAndImage(files) {
  const publicRoute = 'posts/yurayura-first-group-exhibition-report/index.html';
  const html = files.get(publicRoute)?.contents.toString('utf8');
  assert.ok(html, 'the existing published article remains in the production build');
  const src = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(html)?.[1];
  assert.ok(src, 'the published article still contains its cover image');
  const imageUrl = new URL(src.replaceAll('&amp;', '&'), 'https://example.test/blog/');
  const assetMatch = /(?:^|\/)_astro\/([^/?#]+)/.exec(imageUrl.pathname);
  assert.ok(assetMatch, 'the published article cover references an optimized Astro asset');
  const assetPath = '_astro/' + decodeURIComponent(assetMatch[1]);
  assert.ok(files.has(assetPath), 'the published article cover asset is present in dist');
}

async function assertBuildIsolation(direct) {
  const cleanRoot = await createBuildWorkspace({ withPrivateDraft: false });
  let draftRoot;
  try {
    draftRoot = await createBuildWorkspace({ withPrivateDraft: true });
    await runBuild(cleanRoot, direct);
    await runBuild(draftRoot, direct);
    const cleanFiles = await collectBuildFiles(cleanRoot);
    const draftFiles = await collectBuildFiles(draftRoot);
    const cleanNames = [...cleanFiles.keys()].sort();
    const draftNames = [...draftFiles.keys()].sort();
    assert.deepEqual(draftNames, cleanNames, 'private files cannot add or rename any dist artifact');
    for (const name of cleanNames) {
      assert.equal(draftFiles.get(name).sha256, cleanFiles.get(name).sha256, 'private data cannot change dist artifact: ' + name);
    }

    assertPublicArticleAndImage(cleanFiles);
    assertPublicArticleAndImage(draftFiles);
    assert.ok(!draftNames.some((name) => name.startsWith('draft-preview/')), 'draft-preview routes are absent from production output');
    assert.ok(draftFiles.has('posts/' + globPublicSlug + '/index.html'), 'a published filename with glob metacharacters remains included');
    assert.ok(!draftNames.some((name) => name.includes(globPrivateSlug)), 'a neighboring draft cannot match an escaped published path');

    const markers = [privateSlug, privateId, privateTitle, privateBody, ...privateImageNames, contentDraftSlug, contentDraftTitle, contentDraftBody, ...contentDraftImageNames, globPrivateSlug, globPrivateTitle, globPrivateBody];
    for (const [name, artifact] of draftFiles) {
      assert.ok(!markers.some((marker) => name.includes(marker)), 'private identifier is absent from output path: ' + name);
      const output = artifact.contents.toString('utf8');
      for (const marker of markers) {
        assert.ok(!output.includes(marker), 'private content or asset name is absent from ' + name);
      }
    }
  } finally {
    await rm(cleanRoot, { recursive: true, force: true });
    if (draftRoot) await rm(draftRoot, { recursive: true, force: true });
  }
}

test('production output stays isolated in npm and direct Astro builds, even with inherited dev opt-in', async (t) => {
  await t.test('npm run build', () => assertBuildIsolation(false));
  await t.test('astro build', () => assertBuildIsolation(true));
});
