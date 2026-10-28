// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA'S HEADER AND FOOTER ON EVERY PAGE OF THE MENU (kanban #694-#701, 2026-10-26: "the header of those pages does not match the style of
// the arena and games pages", "the home btn is redundant", "the explorer link opens in a new window", "referral pages is missing a option to
// return to the games", "health is missing the header", "all pages are missing the footer", "docs missing footer", "the button to play
// should be renamed to Arena"): one script, src/arena-ui/site-chrome.js, on each of them; the Arena page's own menus carry the same links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillChrome } from '../../../tools/build-arena-page.mjs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const CHROME = read('src/arena-ui/site-chrome.js');

test('each page of the menu, the demo, the docs and the explorer draws the Arena\'s header and footer with site-chrome.js, first in <body>', () => {
  for (const p of ['src/arena-ui/proposals/index.html', 'src/arena-ui/health/index.html', 'src/arena-ui/referral/index.html', 'src/arena-ui/referral-demo/index.html'])
    assert.match(read(p), /<body>\n<script src="\/site-chrome\.js"><\/script>\n/, p);
  // the other domains load it from the Arena site, not a copy
  for (const p of ['src/website/explorer/www/index.html', 'src/website/docs/www/api/index.html', 'src/website/docs/api-template.html'])
    assert.match(read(p), /<body>\n<script src="https:\/\/testnet\.bitcoin-arena\.io\/site-chrome\.js"><\/script>\n/, p);
  for (const p of ['src/website/docs/docs-template.html', 'src/website/docs/www/index.html', 'src/website/www/docs/index.html'])
    assert.match(read(p), /<\/button>\n<script src="https:\/\/testnet\.bitcoin-arena\.io\/site-chrome\.js" data-lead="navbtn"><\/script>\n/, p);
  // no page keeps a bar of its own: no Home, no Play, no "Back to Bitcoin Arena" link of its own
  const forum = read('src/arena-ui/proposals/index.html');
  assert.ok(!forum.includes('<nav>') && !forum.includes('>Home</a>') && !forum.includes('>Play</a>'), 'proposals: no Home and no Play');
  assert.ok(!read('src/arena-ui/referral/index.html').includes('Back to Bitcoin Arena'));
  assert.ok(!read('src/arena-ui/health/index.html').includes('← Bitcoin Arena</a>'));
  assert.ok(!read('src/website/docs/docs-template.html').includes('<nav class="top">'));
  assert.ok(!read('packages/arena-web/src/explorer/main.jsx').includes('<i>₿</i>'), 'the explorer\'s bar has no logo of its own');
});

test('the header: the logo to bitcoin-arena.io, "← Arena" back to the games, ☰ at the right end with the Arena page\'s links, all in the same tab', () => {
  assert.match(CHROME, /<a class="asc-home" href="https:\/\/bitcoin-arena\.io\/"/);
  assert.match(CHROME, /<a class="asc-back" href="' \+ esc\(site\) \+ '"[^>]*><span aria-hidden="true">&larr;<\/span><span class="word">Arena<\/span><\/a>/);
  assert.match(CHROME, /var LINKS = \[\['Proposals', site \+ 'proposals\/'\], \['Explorer', 'https:\/\/explorer\.bitcoin-arena\.io\/'\], \['Health', site \+ 'health\/'\], \['Referral Program', site \+ 'referral\/'\]\];/);
  // no link of the bar or the menu opens a new tab; only the footer's X, Discord and Telegram do (kanban #749, footer-social.test.js)
  assert.ok(!/target=/.test(CHROME.replace(/<span class="asc-social">.*?<\/span>/, '')), 'no other link opens a new tab');
  // the Arena page's two menus: the same links, the explorer in the same tab (#696)
  const page = read('src/arena-ui/index.html');
  const menus = [...page.matchAll(/<nav id="arena-(?:wb-)?nav-menu" class="arena-nav-menu" aria-label="Bitcoin Arena">(.*?)<\/nav>/g)].map((m) => m[1]);
  assert.equal(menus.length, 2);
  for (const m of menus) assert.equal(m, '<a href="/proposals/">Proposals</a><a href="https://explorer.bitcoin-arena.io/">Explorer</a><a href="/health/">Health</a><a href="/referral/">Referral Program</a>');
  // the footer's Donate opens the Arena page's box
  assert.match(CHROME, /<a class="asc-donate" href="' \+ esc\(site\) \+ '#donate">&hearts; Donate<\/a>/);
  assert.match(page, /if \(location\.hash === '#donate'\) \{ try \{ history\.replaceState\(null, '', location\.pathname \+ location\.search\); \} catch \{ \/\* the box opens anyway \*\/ \} window\.ARENA_DONATE_OPEN\(\); \}/);
});

test('the footer\'s line is the Arena page\'s UI number, filled when the page is built; never the static build (kanban #753)', () => {
  const out = fillChrome(CHROME, { pin: { productVersion: '0.0.10' }, ui: 499 });
  assert.match(out, /var STAMP = 'UI 499';/);
  assert.ok(!out.includes('{{{') && !out.includes('0.0.10'));
  assert.throws(() => fillChrome(CHROME + '\n// {{{ OTHER }}}', { pin: { productVersion: '1' }, ui: 1 }), /unfilled template token/);
});
