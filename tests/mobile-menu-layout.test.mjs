import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const layout = await readFile(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');

test('closed mobile menu toggle stays in the sticky header with a 48px touch target', () => {
  const header = /<header class="site-header">([\s\S]*?)<\/header>/.exec(layout)?.[1];
  assert.ok(header, 'site header markup exists');
  assert.ok(header.indexOf('class="brand"') < header.indexOf('class="mobile-menu-toggle"'));
  assert.ok(header.includes('aria-expanded="false"'));
  assert.ok(header.includes('aria-controls="mobile-menu"'));

  const mobileAnchor = css.indexOf('.mobile-menu-toggle,\n.mobile-menu {');
  const mobileStart = css.indexOf('@media (max-width: 1024px) {', mobileAnchor);
  assert.notEqual(mobileAnchor, -1, 'mobile controls have a base rule');
  assert.notEqual(mobileStart, -1, 'mobile breakpoint styles exist');
  let depth = 0;
  let mobileEnd = -1;
  for (let index = mobileStart; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}' && --depth === 0) { mobileEnd = index + 1; break; }
  }
  assert.notEqual(mobileEnd, -1, 'mobile breakpoint block is balanced');
  const mobileRules = css.slice(mobileStart, mobileEnd);
  assert.match(mobileRules, /\.site-header\s*\{[^}]*flex-direction:\s*row/s);
  assert.match(mobileRules, /\.site-nav\s*\{\s*display:\s*none/s);
  const toggleRule = /\.mobile-menu-toggle\s*\{([^}]*)\}/.exec(mobileRules)?.[1];
  assert.ok(toggleRule, 'mobile toggle style exists');
  assert.match(toggleRule, /position:\s*static/);
  assert.match(toggleRule, /display:\s*grid/);
  assert.doesNotMatch(toggleRule, /position:\s*fixed/);
  assert.match(toggleRule, /width:\s*48px/);
  assert.match(toggleRule, /height:\s*48px/);
  assert.match(toggleRule, /flex:\s*0 0 48px/);
  assert.doesNotMatch(mobileRules, /padding-bottom:\s*calc\(84px/);
  assert.match(css, /^\.mobile-menu-toggle,\s*\.mobile-menu\s*\{\s*display:\s*none;\s*\}/m);
  assert.match(css, /\.site-header\s*\{[^}]*position:\s*sticky/s);
});

test('dialog behavior remains wired while only the open-state toggle is fixed', () => {
  assert.match(layout, /const toggleOrigin = mobileMenuToggle/);
  assert.match(layout, /moveToggleIntoDialog\(\)/);
  assert.match(layout, /restoreToggle\(\)/);
  assert.match(layout, /mobileMenu\?\.addEventListener\("cancel"/);
  assert.match(layout, /mobileMenu\?\.addEventListener\("keydown"/);
  assert.match(layout, /event\.key !== "Tab"/);
  assert.match(layout, /event\.target === mobileMenu/);
  assert.match(layout, /target\?\.isConnected\) target\.focus\(\)/);
  assert.match(layout, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.mobile-menu\[open\] > \.mobile-menu-toggle\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /html\.mobile-menu-open\s*\{\s*overflow:\s*hidden/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mobile-menu__panel/);
});
