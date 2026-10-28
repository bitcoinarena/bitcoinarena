// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN ARENA ON X, DISCORD AND TELEGRAM IN EVERY FOOTER (kanban #749, a tester 2026-10-28: "add social media icons (X, Discord,
// Telegram) to the footer of every page of the Bitcoin Arena website and of the app"): each footer's source carries the three links -
// inline SVG, a new tab, no referrer, named for a screen reader - and each page whose footer site-chrome.js draws still loads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const LINKS = [['https://x.com/bitcoinarena_io', 'X'], ['https://discord.gg/tH8SPzyKq', 'Discord'], ['https://t.me/+KihHE8JhcVM3NDVi', 'Telegram']];
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

test('every footer source carries Bitcoin Arena on X, Discord and Telegram, each an inline icon opening a new tab with no referrer', () => {
  for (const [p, n] of Object.entries(SOURCES)) {
    const src = read(p);
    for (const [url, name] of LINKS) {
      const a = new RegExp(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Bitcoin Arena on ${name}" title="${name}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="[^"]+"/></svg></a>`, 'g');
      assert.equal((src.match(a) || []).length, n, `${p}: ${name}`);
    }
    // the same three links in the same order, nothing else between them, and no icon fetched from elsewhere
    const groups = [...src.matchAll(/<(span|div)[^>]* class="(?:asc-|arena-)?social">(.*?)<\/\1>/g)];
    assert.equal(groups.length, n, `${p}: one group per footer`);
    for (const g of groups) assert.deepEqual([...g[2].matchAll(/href="([^"]+)"/g)].map((m) => m[1]), LINKS.map((l) => l[0]), p);
  }
  // one icon per network everywhere: the paths are the same in every source
  const paths = (s) => [...s.matchAll(/aria-label="Bitcoin Arena on (\w+)"[^>]*><svg[^>]*><path d="([^"]+)"/g)].map((m) => m[1] + ' ' + m[2]);
  const want = [...new Set(paths(read('src/arena-ui/site-chrome.js')))];
  assert.equal(want.length, 3);
  for (const p of Object.keys(SOURCES)) assert.deepEqual([...new Set(paths(read(p)))], want, p);
});

test('the pages whose footer is site-chrome.js\'s still load it: the menu pages, the docs and the explorer', () => {
  for (const p of ['src/arena-ui/proposals/index.html', 'src/arena-ui/health/index.html', 'src/arena-ui/referral/index.html', 'src/arena-ui/referral-demo/index.html',
    'src/website/explorer/www/index.html', 'src/website/docs/docs-template.html', 'src/website/docs/api-template.html', 'src/website/docs/www/index.html',
    'src/website/docs/www/api/index.html', 'src/website/www/docs/index.html'])
    assert.match(read(p), /<script src="(?:https:\/\/testnet\.bitcoin-arena\.io)?\/site-chrome\.js"/, p);
});

test('the node pages\' release line no longer replaces the links: it is written into its own span', () => {
  for (const p of ['packages/arena-node/pages/owner.html', 'packages/arena-installer/www/index.html', 'packages/arena-node/src/dashboard.js'])
    assert.match(read(p), /<footer class="build"><span id="build"><\/span><span class="social">/, p);
  assert.ok(!read('packages/arena-node/src/dashboard.js').includes("createElement('footer')"), 'the dashboard\'s footer is in the page, not made after the fetch');
});
