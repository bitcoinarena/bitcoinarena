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
    assert.match(read(p), /<body>\n<script src="https:\/\/testnet\.bitcoin-?arena\.io\/site-chrome\.js"><\/script>\n/, p);
  for (const p of ['src/website/docs/docs-template.html', 'src/website/docs/www/index.html', 'src/website/www/docs/index.html'])
    assert.match(read(p), /<\/button>\n<script src="https:\/\/testnet\.bitcoin-?arena\.io\/site-chrome\.js" data-lead="navbtn"><\/script>\n/, p);
  // no page keeps a bar of its own: no Home, no Play, no "Back to Bitcoin Arena" link of its own
  const forum = read('src/arena-ui/proposals/index.html');
  assert.ok(!forum.includes('<nav>') && !forum.includes('>Home</a>') && !forum.includes('>Play</a>'), 'proposals: no Home and no Play');
  assert.ok(!read('src/arena-ui/referral/index.html').includes('Back to Bitcoin Arena'));
  assert.ok(!read('src/arena-ui/health/index.html').includes('← Bitcoin Arena</a>'));
  assert.ok(!read('src/website/docs/docs-template.html').includes('<nav class="top">'));
  assert.ok(!read('packages/arena-web/src/explorer/main.jsx').includes('<i>₿</i>'), 'the explorer\'s bar has no logo of its own');
});

test('the header is the start page\'s (kanban #1457, Daniel 2026-11-11: "Der Header muss überall gleich aussehen"): the stadium and the name to bitcoinarena.io, its links, the Nostr badge and App, all in the same tab', () => {
  assert.match(CHROME, /<a class="asc-brand" href="' \+ HOME \+ '" aria-label="Bitcoin Arena"><img class="asc-mark" src="' \+ mark \+ 'bitcoin-arena-mark-90\.webp"/);
  assert.match(CHROME, /var HOME = 'https:\/\/bitcoinarena\.io\/';/);
  for (const [name, href] of [['Games', "HOME \\+ '#games'"], ['How it works', "HOME \\+ '#how'"], ['Explorer', "'https://explorer\\.bitcoinarena\\.io/'"], ['Build &amp; run', "HOME \\+ '#build'"], ['Download', "HOME \\+ '#download'"],
    ['Proposals', "'https:\\/\\/testnet\\.bitcoinarena\\.io\\/proposals\\/'"], ['Security', "HOME \\+ 'security\\/'"], ['Docs', "'https:\\/\\/docs\\.bitcoinarena\\.io\\/'"]])
    assert.match(CHROME, new RegExp(`\\['${name}', ${href}`), name);
  // the same as the start page's own nav.top: the same links in the same order, App to the game page
  const home = read('src/website/www/index.html');
  const homeLinks = [...home.match(/<nav class="top">[\s\S]*?<\/nav>/)[0].matchAll(/<a (?:class="keep" )?href="[^"]*">([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(homeLinks, ['Games', 'How it works', 'Explorer', 'Build &amp; run', 'Download', 'Proposals', 'Security', 'Docs']);
  assert.match(CHROME, /<a class="asc-app" href="https:\/\/testnet\.bitcoinarena\.io\/">App &rarr;<\/a>/);
  // no link of the bar opens a new tab; only the footer's X, Discord and Telegram do (kanban #749, footer-social.test.js)
  assert.ok(!/target=/.test(CHROME.replace(/<span class="asc-social">.*?<\/span>/, '')), 'no other link opens a new tab');
  const page = read('src/arena-ui/index.html');
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

test('the start page\'s navigation links Explorer, not Nostr (kanban #1464, ported to 2.0 by #1489)', () => {
  const links = read('src/website/www/index.html').match(/<div class="links">.*?<\/div>/)[0];
  assert.match(links, /<a href="#how">How it works<\/a><a href="https:\/\/explorer\.bitcoinarena\.io\/">Explorer<\/a><a href="#build">/);
  assert.ok(!/>Nostr<\/a>/.test(links), 'no Nostr link in the navigation');
});
