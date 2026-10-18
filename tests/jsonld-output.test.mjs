import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

test('Astro generated JSON-LD HTML keeps script-closing text inside valid JSON', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'blog-jsonld-html-'));
  try {
    for (const name of ['astro.config.mjs', 'package.json', 'tsconfig.json', 'src', 'public']) {
      await cp(path.join(repoRoot, name), path.join(temporaryRoot, name), { recursive: true });
    }
    const localModules = path.join(temporaryRoot, 'node_modules');
    await mkdir(localModules);
    for (const entry of await readdir(path.join(repoRoot, 'node_modules'), { withFileTypes: true })) {
      if (entry.name === '.vite' || entry.name === '.astro') continue;
      const source = path.join(repoRoot, 'node_modules', entry.name);
      await symlink(source, path.join(localModules, entry.name), 'dir');
    }
    await mkdir(path.join(localModules, '.vite'));
    await mkdir(path.join(localModules, '.astro'));
    const fixturePath = path.join(temporaryRoot, 'src/pages/jsonld-security-fixture.astro');
    await mkdir(path.dirname(fixturePath), { recursive: true });
    const unsafeName = '日本語 "引用" \\\\ <tag> </script><script>alert("x")</script> &';
    const fixture = [
      '---',
      "import BaseLayout from '../layouts/BaseLayout.astro';",
      'const structuredData = {',
      "  '@context': 'https://schema.org',",
      "  '@type': 'Thing',",
      '  name: __UNSAFE_NAME__,',
      '};',
      '---',
      '<BaseLayout title="JSON-LD security fixture" description="Generated HTML regression fixture with script-closing text and Unicode characters." canonical="https://example.invalid/jsonld-security-fixture/" structuredData={structuredData}>',
      '  <h1>JSON-LD security fixture</h1>',
      '</BaseLayout>',
      '',
    ].join('\n').replace('__UNSAFE_NAME__', JSON.stringify(unsafeName));
    await writeFile(fixturePath, fixture, { flag: 'wx' });

    const astroCli = path.join(repoRoot, 'node_modules/astro/bin/astro.mjs');
    const build = spawnSync(process.execPath, [astroCli, 'build'], {
      cwd: temporaryRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const html = await readFile(path.join(temporaryRoot, 'dist/jsonld-security-fixture/index.html'), 'utf8');
    const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    assert.ok(jsonLd, 'generated HTML contains its JSON-LD script');
    assert.doesNotMatch(jsonLd[1], /<\/script/i, 'untrusted text cannot close the JSON-LD script');
    assert.match(jsonLd[1], /\\u003c\/script>/, 'less-than is serialized as a literal JSON unicode escape');
    assert.equal(JSON.parse(jsonLd[1]).name, unsafeName, 'JSON parsing preserves Japanese, quotes, backslashes, and special characters');

    for (const tag of [
      /<meta property="og:title"/g,
      /<meta property="og:image"/g,
      /<meta name="twitter:card"/g,
      /<meta name="twitter:title"/g,
      /<meta name="twitter:image"/g,
    ]) {
      assert.equal((html.match(tag) ?? []).length, 1, 'existing SEO and social metadata remains singular');
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
