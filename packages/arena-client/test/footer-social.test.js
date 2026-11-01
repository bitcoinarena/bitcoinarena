// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN ARENA ON X, DISCORD AND TELEGRAM IN EVERY FOOTER (kanban #749, a tester 2026-10-28: "add social media icons (X, Discord,
// Telegram) to the footer of every page of the Bitcoin Arena website and of the app"): each footer's source carries the three links -
// inline SVG, a new tab, no referrer, named for a screen reader - and each page whose footer site-chrome.js draws still loads it.
// GITHUB BESIDE THEM, NO BUILD LINE, CLEAR OF DONATE (kanban #753, a tester 2026-10-28: "donate button is too close to donate button",
// "Remove the static build display", "create a page on docs to link them all and add a GitHub icon"): a fourth link, GitHub, to the docs'
// Repositories page; the links stand well clear of Donate. The footers keep "UI n" (the node pages their release) but never the static
// build (2026-10-28: "I want 'UI xxx' still there, just not 'build 0.0.10' which was static").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const LINKS = [['https://x.com/bitcoinarena_io', 'X'], ['https://discord.gg/9zZbASZyue', 'Discord'], ['https://t.me/+KihHE8JhcVM3NDVi', 'Telegram'],
  ['https://docs.bitcoinarena.io/repos/', 'GitHub']];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// every footer that ships, by its source (the page folders are build output)
const SOURCES = {
  // the Arena site's menu pages, the docs and the explorer (the footer site-chrome.js draws)
  'src/arena-ui/site-chrome.js': 1,
  // the Arena page: the foot at the window's bottom right over every screen, and the games screen's foot row
  'src/arena-ui/index.html': 2,
  // bitcoinarena.io: the landing page and the live games
  'src/website/www/index.html': 1,
  // the node's own pages: the owner page (also on the Arena site at /owner/), its dashboard, and the installer's wizard
  'packages/arena-node/pages/owner.html': 1,
  'packages/arena-node/src/dashboard.js': 1,
  'packages/arena-installer/www/index.html': 1,
};

test('every footer source carries Bitcoin Arena on X, Discord, Telegram and GitHub, each an inline icon opening a new tab with no referrer', () => {
  for (const [p, n] of Object.entries(SOURCES)) {
    const src = read(p);
    for (const [url, name] of LINKS) {
      const a = new RegExp(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Bitcoin Arena on ${name}" title="${name}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="[^"]+"/></svg></a>`, 'g');
      assert.equal((src.match(a) || []).length, n, `${p}: ${name}`);
    }
    // the same four links in the same order, nothing else between them, and no icon fetched from elsewhere
    const groups = [...src.matchAll(/<(span|div)[^>]* class="(?:asc-|arena-)?social">(.*?)<\/\1>/g)];
    assert.equal(groups.length, n, `${p}: one group per footer`);
    for (const g of groups) assert.deepEqual([...g[2].matchAll(/href="([^"]+)"/g)].map((m) => m[1]), LINKS.map((l) => l[0]), p);
  }
  // one icon per network everywhere: the paths are the same in every source
  const paths = (s) => [...s.matchAll(/aria-label="Bitcoin Arena on (\w+)"[^>]*><svg[^>]*><path d="([^"]+)"/g)].map((m) => m[1] + ' ' + m[2]);
  const want = [...new Set(paths(read('src/arena-ui/site-chrome.js')))];
  assert.equal(want.length, 4);
  for (const p of Object.keys(SOURCES)) assert.deepEqual([...new Set(paths(read(p)))], want, p);
});

test('the pages whose footer is site-chrome.js\'s still load it: the menu pages, the docs and the explorer', () => {
  for (const p of ['src/arena-ui/proposals/index.html', 'src/arena-ui/health/index.html', 'src/arena-ui/referral/index.html', 'src/arena-ui/referral-demo/index.html',
    'src/website/explorer/www/index.html', 'src/website/docs/docs-template.html', 'src/website/docs/api-template.html', 'src/website/docs/www/index.html',
    'src/website/docs/www/api/index.html', 'src/website/www/docs/index.html', 'src/website/docs/repos-template.html', 'src/website/docs/www/repos/index.html'])
    assert.match(read(p), /<script src="(?:https:\/\/testnet\.bitcoin-?arena\.io)?\/site-chrome\.js"/, p);
});

test('every footer says the UI number or the release, never the static build (#753, 2026-10-28: "just not build 0.0.10 which was static")', () => {
  // the node's pages: the release alone in its own span before the links, no build commit
  for (const p of ['packages/arena-node/pages/owner.html', 'packages/arena-installer/www/index.html', 'packages/arena-node/src/dashboard.js']) {
    const src = read(p);
    assert.match(src, /<footer class="build"><span id="build"><\/span><span class="social">.*?<\/span><\/footer>/, p);
    assert.match(src, /getElementById\('build'\)\.textContent ?= ?(?:'Bitcoin Arena ' ?\+ ?v\.version|`Bitcoin Arena \$\{st\.build\.version\}`)/, p);
    assert.ok(!/'build ' ?\+|· build \$\{/.test(src), `${p}: no build commit in the footer`);
    assert.match(src, /footer\.build #build:not\(:empty\)\{margin-right:16px\}/, p);
  }
  assert.ok(!read('packages/arena-node/src/dashboard.js').includes("createElement('footer')"), 'the dashboard\'s footer is in the page, not made after the fetch');
  assert.match(read('packages/arena-node/pages/owner.html'), /<h1>Bitcoin Arena · Node Owner <span class="ver" id="ver"><\/span><\/h1>/);
  assert.match(read('packages/arena-installer/www/index.html'), /<h1>Bitcoin Arena setup <span class="ver" id="ver"><\/span><\/h1>/);
  // site-chrome.js: "UI n" left, then the links and Donate
  const chrome = read('src/arena-ui/site-chrome.js');
  assert.match(chrome, /var STAMP = 'UI \{\{\{ UI_VERSION \}\}\}';/);
  assert.ok(!chrome.includes('PRODUCT_VERSION'));
  assert.match(chrome, /f\.innerHTML = '<span class="asc-build" aria-hidden="true">' \+ [^\n]*\n\s+\+ '<span class="asc-social">.*?<\/span>'\n\s+\+ '<a class="asc-donate"/);
  // the Arena page: the fixed line, the games row and the loading screen say "UI n"; the static build is nowhere visible
  const page = read('src/arena-ui/index.html');
  assert.match(page, /<div id="arena-build" aria-hidden="true">UI \{\{\{ UI_VERSION \}\}\}<\/div>/);
  assert.match(page, /<div class="foot-row"><span class="build-line">UI \{\{\{ UI_VERSION \}\}\}<\/span><span class="arena-social">.*?<\/span><button type="button" class="donate-btn"[^>]*>&hearts; Donate<\/button><\/div>/);
  assert.match(page, /<div class="build-line" id="boot-build">UI \{\{\{ UI_VERSION \}\}\}<\/div>/);
  // PRODUCT_VERSION only where nobody reads it on screen: #boot's data attribute, the page's config and the order timing's ui
  const uses = [...page.matchAll(/.{0,40}\{\{\{ PRODUCT_VERSION \}\}\}/g)].map((m) => m[0]);
  assert.equal(uses.length, 3, uses.join(' | '));
  assert.ok(uses.some((u) => u.includes('data-build="')) && uses.some((u) => u.includes("productVersion: '")) && uses.some((u) => u.includes("ui: 'build ")), uses.join(' | '));
  // the fixed line ends 16 px left of the links (their left edge 214 px from the right) wherever it shows
  assert.equal((page.match(/padding: 0 230px 0 8px;/g) || []).length, 2);
  assert.match(page, /html body\.arena-own-client #arena-build \{ height: calc\(30px \+ env\(safe-area-inset-bottom, 0px\)\); line-height: 30px; padding-right: 230px; font-size: 10px; \}/);
});

test('the links stand clear of Donate (#753): 16 px more than the row gap in site-chrome, 14 px in the games row, 20 px left of the fixed Donate', () => {
  assert.match(read('src/arena-ui/site-chrome.js'), /#asc-foot \.asc-social \{ flex: none; display: inline-flex; align-items: center; gap: 6px; margin: 0 16px 0 0;/);
  const page = read('src/arena-ui/index.html');
  assert.match(page, /#arena-games \.foot-row \.arena-social \{ display: flex; flex: none; gap: 6px; margin: 0 14px 0 auto; \}/);
  // the fixed Donate is at right: 6px, at most 74 px wide: the links' right edge at 100 px leaves 20 px
  assert.match(page, /gap: 6px; position: fixed; right: 100px;/);
  assert.match(page, /#arena-donate-go \{ display: block; position: fixed; right: 6px;/);
});
