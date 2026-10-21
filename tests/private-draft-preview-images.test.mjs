import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, cp, readdir } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  getPrivateDraftIdFromEntryPath,
  isPrivateDraftAssetRequestLocal,
  privateDraftAssetUrl,
  resolvePrivateDraftAsset,
} from '../src/lib/private-draft-assets.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureId = 'draft-20990101-000001';
const fixtureSlug = 'phase2c-private-image-fixture';
const noImageId = 'draft-20990101-000002';
const noImageSlug = 'phase2c-private-no-image-fixture';
const secondId = 'draft-20990101-000003';
const secondSlug = 'phase2c-private-second-fixture';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
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

async function writeDraft(root, { id, slug, cover, bodyImage }) {
  const directory = path.join(root, '.private-drafts', id);
  await mkdir(directory, { recursive: true });
  if (cover) await writeFile(path.join(directory, 'cover.png'), cover);
  if (bodyImage) await writeFile(path.join(directory, 'body.png'), bodyImage);
  const fields = [
    '---',
    'title: "Phase 2C private preview fixture"',
    'slug: "' + slug + '"',
    'description: "架空の非公開テスト記事で、ローカルプレビュー画像の安全な表示と記事データの同期を確認します。"',
    'pubDate: "2026-10-19"',
    'category: "Creative"',
    'tags: ["private-preview-test"]',
    'draft: true',
    'workflowStatus: "Review"',
  ];
  if (cover) fields.push('cover: "./cover.png"', 'coverAlt: "fixture cover"');
  if (cover) fields.push('ogImage: "./cover.png"', 'ogImageAlt: "fixture social image"');
  fields.push('---', '', '## Preview fixture', '', 'この本文は自動回帰テスト用です。');
  if (bodyImage) fields.push('', '![fixture body image](./body.png)');
  await writeFile(path.join(directory, 'index.md'), fields.join('\n'), { flag: 'wx' });
}

async function getFreePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForPage(url, child, getLogs, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastStatus = null;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Astro dev stopped before the preview returned HTTP 200 (code=' + child.exitCode +
        ', signal=' + child.signalCode + ', lastStatus=' + lastStatus + ').\n' + getLogs());
    }
    attempts += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return response;
      lastStatus = response.status;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Astro preview route did not return HTTP 200 within ' + timeoutMs + 'ms (' +
    attempts + ' attempts, lastStatus=' + lastStatus + ', lastError=' + String(lastError) + ').\n' +
    getLogs().slice(-6000));
}

test('private draft image paths reject traversal, symlinks, and non-loopback access', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-private-image-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const draftDir = path.join(root, '.private-drafts', fixtureId);
  await mkdir(draftDir, { recursive: true });
  const image = pngFixture([31, 80, 170]);
  await writeFile(path.join(draftDir, 'cover.png'), image);
  await writeFile(path.join(root, 'outside.png'), image);
  await symlink(path.join(root, 'outside.png'), path.join(draftDir, 'escape.png'));

  assert.equal(getPrivateDraftIdFromEntryPath({
    root,
    entryPath: '.private-drafts/' + fixtureId + '/index.md',
  }), fixtureId);
  assert.equal(privateDraftAssetUrl(fixtureId, './cover.png'), '/__local-draft-assets/' + fixtureId + '/cover.png');
  assert.equal((await resolvePrivateDraftAsset({ root, draftId: fixtureId, reference: './cover.png' })).mimeType, 'image/png');
  assert.throws(() => privateDraftAssetUrl(fixtureId, '../outside.png'));
  await assert.rejects(resolvePrivateDraftAsset({ root, draftId: fixtureId, reference: '../outside.png' }));
  await assert.rejects(resolvePrivateDraftAsset({ root, draftId: fixtureId, reference: './escape.png' }));
  await assert.rejects(resolvePrivateDraftAsset({ root, draftId: fixtureId, reference: './index.md' }));

  const allowedRequest = {
    headers: { host: '127.0.0.1:4322' },
    socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
  };
  assert.equal(isPrivateDraftAssetRequestLocal(allowedRequest, { address: '127.0.0.1', port: 4322 }), true);
  assert.equal(isPrivateDraftAssetRequestLocal({ ...allowedRequest, headers: { host: 'localhost:4322' } }, { address: '127.0.0.1' }), false);
  assert.equal(isPrivateDraftAssetRequestLocal({ ...allowedRequest, socket: { localAddress: '127.0.0.1', remoteAddress: '192.168.1.20' } }, { address: '127.0.0.1' }), false);
  assert.equal(isPrivateDraftAssetRequestLocal(allowedRequest, { address: '0.0.0.0', port: 4322 }), false);
});

test('Astro dev preview resolves private cover, OGP, Markdown images, empty images, and multiple Review drafts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-private-preview-dev-'));
  let child;
  let childLogs = '';
  t.after(async () => {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 4000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  for (const name of ['astro.config.mjs', 'package.json', 'tsconfig.json', 'src', 'public']) {
    await cp(path.join(repoRoot, name), path.join(root, name), { recursive: true });
  }
  await mkdir(path.join(root, '.private-drafts'), { recursive: true });
  await linkDependencies(root);

  const coverBytes = pngFixture([211, 37, 72]);
  const bodyBytes = pngFixture([45, 79, 199]);
  await writeDraft(root, { id: fixtureId, slug: fixtureSlug, cover: coverBytes, bodyImage: bodyBytes });
  await writeDraft(root, { id: noImageId, slug: noImageSlug });
  await writeDraft(root, { id: secondId, slug: secondSlug, cover: coverBytes });

  const port = await getFreePort();
  child = spawn(process.execPath, [
    path.join(root, 'node_modules/.bin/astro'),
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
    '--ignore-lock',
  ], { cwd: root, env: { ...process.env, BLOG_LOAD_LOCAL_DRAFTS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (part) => { childLogs += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { childLogs += part; });

  const origin = 'http://127.0.0.1:' + port;
  const pageUrl = origin + '/blog/draft-preview/' + fixtureSlug + '/';
  const pageResponse = await waitForPage(pageUrl, child, () => childLogs);
  const html = await pageResponse.text();
  assert.equal(pageResponse.status, 200, html + '\n' + childLogs);
  assert.ok(html.includes('Phase 2C private preview fixture'));
  assert.ok(html.includes('robots') && html.includes('noindex'));
  assert.ok(html.includes('http://127.0.0.1:' + port + '/__local-draft-assets/' + fixtureId + '/cover.png'), 'OGP points to the local-only image route');

  const coverTag = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]).find((tag) => tag.includes('article-cover__image'));
  assert.ok(coverTag, 'cover is rendered as a native image with resolved dimensions');
  assert.match(coverTag, /width="2"/);
  assert.match(coverTag, /height="2"/);
  const coverSrc = /\bsrc="([^"]+)"/.exec(coverTag)?.[1];
  assert.equal(coverSrc, '/__local-draft-assets/' + fixtureId + '/cover.png');

  const coverResponse = await fetch(new URL(coverSrc, origin));
  assert.equal(coverResponse.status, 200);
  assert.equal(coverResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await coverResponse.arrayBuffer()), coverBytes);

  assert.ok(html.includes('alt="fixture body image"'), 'local Markdown image is rewritten for the private preview route');
  assert.ok(html.includes('/__local-draft-assets/' + fixtureId + '/body.png'));
  const bodyResponse = await fetch(origin + '/__local-draft-assets/' + fixtureId + '/body.png');
  assert.equal(bodyResponse.status, 200);
  assert.deepEqual(Buffer.from(await bodyResponse.arrayBuffer()), bodyBytes);

  const escapedResponse = await fetch(origin + '/__local-draft-assets/' + fixtureId + '/escape.png');
  assert.equal(escapedResponse.status, 404, 'symlink targets are not served');

  const noImageResponse = await fetch(origin + '/blog/draft-preview/' + noImageSlug + '/');
  assert.equal(noImageResponse.status, 200, 'image-free Review drafts remain previewable');
  const noImageHtml = await noImageResponse.text();
  assert.equal([...noImageHtml.matchAll(/<img[^>]+>/gi)].some(([tag]) => tag.includes('article-cover__image')), false);
  const noImageOg = /<meta property="og:image" content="([^"]+)"/.exec(noImageHtml)?.[1];
  assert.ok(noImageOg && !noImageOg.includes('/__local-draft-assets/'), 'image-free drafts keep the shared public OGP fallback');

  const secondResponse = await fetch(origin + '/blog/draft-preview/' + secondSlug + '/');
  assert.equal(secondResponse.status, 200, 'multiple Review drafts coexist');
  assert.equal(secondResponse.headers.get('cache-control'), null);
});
