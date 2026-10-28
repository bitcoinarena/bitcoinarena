// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN ARENA ON X, DISCORD AND TELEGRAM IN EVERY FOOTER (kanban #749, a tester 2026-10-28: "add social media icons (X, Discord,
// Telegram) to the footer of every page of the Bitcoin Arena website and of the app"): each footer's source carries the three links -
// inline SVG, a new tab, no referrer, named for a screen reader - and each page whose footer site-chrome.js draws still loads it.
// GITHUB BESIDE THEM, NO BUILD LINE, CLEAR OF DONATE (kanban #753, a tester 2026-10-28: "donate button is too close to donate button",
// "Remove the static build display", "create a page on docs to link them all and add a GitHub icon"): a fourth link, GitHub, to the docs'
// Repositories page; no footer carries a build or release line; the links stand well clear of Donate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const LINKS = [['https://x.com/bitcoinarena_io', 'X'], ['https://discord.gg/tH8SPzyKq', 'Discord'], ['https://t.me/+KihHE8JhcVM3NDVi', 'Telegram'],
  ['https://docs.bitcoin-arena.io/repos/', 'GitHub']];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// every footer that ships, by its source (the page folders are build output)
const SOURCES = {
  // the Arena site's menu pages, the docs and the explorer (the footer site-chrome.js draws)
  'src/arena-ui/site-chrome.js': 1,
  // the Arena page: the foot at the window's bottom right over every screen, and the games screen's foot row
  'src/arena-ui/index.html': 2,
  // bitcoin-arena.io: the landing page and the live games
  'src/website/www/index.html': 1,
  'src/website/www/games/index.html': 1,
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
    assert.match(read(p), /<script src="(?:https:\/\/testnet\.bitcoin-arena\.io)?\/site-chrome\.js"/, p);
});

test('no footer carries a build or release line (#753); the node pages show their release beside the title instead', () => {
  // the node's pages: the footer is the links alone; nothing writes into it
  for (const p of ['packages/arena-node/pages/owner.html', 'packages/arena-installer/www/index.html', 'packages/arena-node/src/dashboard.js']) {
    const src = read(p);
    assert.match(src, /<footer class="build"><span class="social">.*?<\/span><\/footer>/, p);
    assert.ok(!/id="build"|getElementById\('build'\)/.test(src), `${p}: no release line in the footer`);
  }
  assert.ok(!read('packages/arena-node/src/dashboard.js').includes("createElement('footer')"), 'the dashboard\'s footer is in the page, not made after the fetch');
  // ... the release beside the title: the owner page and the installer fill .ver; the dashboard's React title carries it (#674)
  assert.match(read('packages/arena-node/pages/owner.html'), /<h1>Bitcoin Arena · Node Owner <span class="ver" id="ver"><\/span><\/h1>/);
  assert.match(read('packages/arena-node/pages/owner.html'), /document\.getElementById\('ver'\)\.textContent = v\.version/);
  const inst = read('packages/arena-installer/www/index.html');
  assert.match(inst, /<h1>Bitcoin Arena setup <span class="ver" id="ver"><\/span><\/h1>/);
  assert.match(inst, /if \(st\.build && st\.build\.version\) document\.getElementById\('ver'\)\.textContent = st\.build\.version;/);
  assert.match(read('packages/arena-web/src/dashboard/DashboardPage.jsx'), /<span className="ver" id="release">/);
  // site-chrome.js: no stamp and no build span; its footer is the links and Donate
  const chrome = read('src/arena-ui/site-chrome.js');
  assert.ok(!/STAMP|asc-build|\{\{\{/.test(chrome), 'site-chrome.js has no build line');
  assert.match(chrome, /f\.innerHTML = '<span class="asc-social">.*?<\/span>'\n\s+\+ '<a class="asc-donate"/);
  // the Arena page: no fixed build line, none in the games screen's foot row; the build stays on the loading screen's last line
  const page = read('src/arena-ui/index.html');
  assert.ok(!page.includes('arena-build'), 'no #arena-build');
  assert.match(page, /<div class="foot-row"><span class="arena-social">.*?<\/span><button type="button" class="donate-btn"[^>]*>&hearts; Donate<\/button><\/div>/);
  assert.equal((page.match(/build \{\{\{ PRODUCT_VERSION \}\}\} · UI \{\{\{ UI_VERSION \}\}\}/g) || []).length, 2, 'the loading screen\'s line and the order timing\'s ui');
  assert.match(page, /<div class="build-line" id="boot-build">build \{\{\{ PRODUCT_VERSION \}\}\} · UI \{\{\{ UI_VERSION \}\}\}<\/div>/);
  assert.ok(!/#boot-build \{ display: none; \}/.test(page), 'the loading screen\'s build line is no longer hidden for a footer line');
  assert.match(page, /ui: 'build \{\{\{ PRODUCT_VERSION \}\}\} · UI \{\{\{ UI_VERSION \}\}\}', agent:/);
  // over a game's own client the foot is still its 30 px strip, empty
  assert.match(page, /<div id="arena-foot" aria-hidden="true"><\/div>/);
  assert.match(page, /html body\.arena-own-client #arena-foot \{ height: calc\(30px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
});

test('the links stand clear of Donate (#753): 16 px more than the row gap in site-chrome, 14 px in the games row, 20 px left of the fixed Donate', () => {
  assert.match(read('src/arena-ui/site-chrome.js'), /#asc-foot \.asc-social \{ flex: none; display: inline-flex; align-items: center; gap: 6px; margin: 0 16px 0 0;/);
  const page = read('src/arena-ui/index.html');
  assert.match(page, /#arena-games \.foot-row \.arena-social \{ display: flex; flex: none; gap: 6px; margin: 0 14px 0 auto; \}/);
  // the fixed Donate is at right: 6px, at most 74 px wide: the links' right edge at 100 px leaves 20 px
  assert.match(page, /gap: 6px; position: fixed; right: 100px;/);
  assert.match(page, /#arena-donate-go \{ display: block; position: fixed; right: 6px;/);
});
