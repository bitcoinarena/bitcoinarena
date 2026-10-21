// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY LOADING SCREEN THE SAME (2026-10-16: the platform link "is on the loading screen of tic toc next block
// and should also be on the other games. actually, make sure all loading screens look consistent"). On the page's own CSS and
// code: another game's loading screen keeps Tick Tock's bar, step, platform link and build line, and its title is the game's
// icon and name as Tick Tock's title is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { ArenaText, ArenaBits } from './arena-text.js';   // the page's React lines (kanban #564)

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');

test('another game hides only what a Unity download has: never the bar, the step, the link or the build line', () => {
  const hide = HTML.match(/((?:\s*html\.other-game #[\w-]+,?)+) \{ display: none !important; \}/)[1];
  const hidden = [...hide.matchAll(/#([\w-]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(hidden, ['howto', 'note', 'pctwrap', 'sub', 'title']);
  assert.doesNotMatch(HTML, /html\.other-game #stage \{/, 'the step at Tick Tock\'s size');
  assert.doesNotMatch(HTML, /<div class="dots">/, 'no dots: the bar shows the wait');
  assert.match(HTML, /html\.other-game #bar \{[^}]*animation: other-load/, 'the bar runs');
  assert.match(HTML, /html\.other-game #site-splash \{ display: flex; align-items: center; gap: 0\.45em; font-size: clamp\(22px, 5vw, 40px\); font-weight: 700;/,
    'the title at Tick Tock\'s title size, icon beside the name');
});

test('a chosen game puts its name and its icon in the loading screen\'s title', () => {
  const from = HTML.indexOf("        if (document.documentElement.classList.contains('other-game')) { const n = document.getElementById('site-name');");
  assert.ok(from > 0);
  const src = HTML.slice(from, HTML.indexOf("i.textContent = ''; }\n", HTML.indexOf("else if (i && document.documentElement.classList.contains('arena-root'))", from)) + 21);
  // the icons box as the page has it: empty, or holding the page's own copy of the icon (a data: image) since the first paint
  const el = (img = null) => ({ textContent: '', kids: img ? [img] : [], append(x) { this.kids.push(x); }, querySelector: (q) => (q === 'img' ? img : null) });
  const run = (icons) => {
    const els = { 'site-name': el(), 'site-icons': icons };
    const document = { documentElement: { classList: { contains: (c) => c === 'other-game' } }, getElementById: (id) => els[id], createElement: () => ({}) };
    pageFunction(PAGE, ['document', 'window', 'game'], src)(document, { ArenaText }, { name: 'btc-updown-15m', title: 'Bitcoin Up or Down', icon: 'https://x/icon.svg' });
    return els;
  };
  const fetched = run(el());
  assert.equal(fetched['site-name'].textContent, 'Bitcoin Up or Down');
  assert.equal(fetched['site-icons'].kids.length, 1); assert.equal(fetched['site-icons'].kids[0].src, 'https://x/icon.svg');
  // the page's own copy stays: the icon is not fetched again over it
  const own = { src: 'data:image/svg+xml,<svg/>' };
  const kept = run(el(own));
  assert.deepEqual(kept['site-icons'].kids, [own]);
});
