// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL RESERVES ON BITCOIN-ARENA.IO (2026-10-17: "Find a prominent place on the website under the
// USPs to show the reserves ... Under the fees"): the homepage's own script asks the testnet's nodes (daily.json) for /reserves
// and shows the total only when five name the same one; the games screen no longer carries the reserves box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOME = new URL('../../../deploy/home-site/www/', import.meta.url);
const SCRIPT = readFileSync(new URL('js/reserves.js', HOME), 'utf8');
const HTML = readFileSync(new URL('index.html', HOME), 'utf8');
const GAMES = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');

function homepage(answers) {
  const els = { total: { textContent: '' }, line: { textContent: '' } };
  const root = { dataset: {}, querySelector: (q) => (q === '[data-r="total"]' ? els.total : els.line) };
  const nodes = answers.map((_, i) => `https://seat-${i}.example/`);
  const fetcher = async (u) => {
    if (u.endsWith('daily.json')) return { ok: true, json: async () => ({ testnet: { node: nodes } }) };
    const a = answers[Number(new URL(u).host.split('-')[1].split('.')[0])];
    if (a === undefined) throw new Error('down');
    return { ok: true, json: async () => a };
  };
  const window = {};
  vm.runInNewContext(SCRIPT, { window, document: { getElementById: () => null }, AbortSignal, BigInt, Promise, Number, String, Object, Array, Set });
  return window.ARENA_HOME_RESERVES.show(root, fetcher).then((r) => ({ r, root, total: els.total.textContent, line: els.line.textContent }));
}

test('five of seven name 102,000 msat: the homepage shows 102 sat with its payments in; one higher and one down do not move it', async () => {
  const ok = { totalMsat: '102000', entries: 2 };
  const h = await homepage([ok, ok, ok, ok, ok, { totalMsat: '999999000', entries: 9 }, undefined]);
  assert.deepEqual([h.total, h.line, h.root.dataset.state], ['102', '2 payments in · 5 of 7 nodes agree · Bitcoin testnet4', 'ok']);
});

test('four agreeing, or no answers: no number, and it says why', async () => {
  const a = { totalMsat: '2000', entries: 1 }, b = { totalMsat: '4000', entries: 2 };
  const four = await homepage([a, a, a, a, b, b, b]);
  assert.deepEqual([four.total, four.root.dataset.state], ['—', 'none']); assert.match(four.line, /only 4 of 7 nodes name the same total/);
  const none = await homepage([undefined, undefined]);
  assert.match(none.line, /none of 2 nodes answered/);
});

test('the panel sits under the fees on bitcoin-arena.io, and the games screen carries no reserves box and no footer home link', () => {
  const fees = HTML.indexOf('<section id="split"'), panel = HTML.indexOf('id="reserves"'), next = HTML.indexOf('<section id="build"');
  assert.ok(fees > 0 && panel > fees && panel < next, 'the reserves panel is inside the fees section');
  assert.ok(HTML.includes('<script src="js/reserves.js" defer></script>'));
  assert.equal(GAMES.includes('class="reserves"'), false, 'no reserves box on the games screen');
  assert.equal(/more-sep"> · <\/span><a href="https:\/\/bitcoin-arena.io\/">/.test(GAMES), false, 'no "← bitcoin-arena.io" in the footer links');
});

test('the website and the docs say the current split, the reserves and that anyone may propose a payout', () => {
  const DOCS = readFileSync(new URL('../../../deploy/doc-site/www/index.html', import.meta.url), 'utf8');
  assert.match(HTML, /aria-label="A paid stake: 90 % in play, 4 % node fee, 2 % game developer, 2 % protocol developers, 2 % protocol reserves"/);
  assert.match(HTML, /<b>Anyone<\/b> can propose a payout/);
  for (const id of ['money', 'reserves', 'proposals']) assert.ok(DOCS.includes(`id="${id}"`), `docs section #${id}`);
  assert.match(DOCS, /<b>Anyone can propose a payout<\/b>/);
  assert.match(DOCS, /It passes when 60% of the votes say YES and YES is at least 20% of everyone who could vote/);
  assert.match(DOCS, /<b>Five rules, so nobody can rent a majority.<\/b>/);
  assert.match(DOCS, /bond &times; age: 1&times; under a year, 2&times; from one year, 3&times; from two/);
  assert.equal(readFileSync(new URL('../../../deploy/home-site/www/docs/index.html', import.meta.url), 'utf8'), DOCS, 'the homepage\'s /docs copy is the same page');
});

test('the website names only the current configuration; the proposals forum is its own page beside the Arena, on the player key', () => {
  const GAMES_PAGE = readFileSync(new URL('games/index.html', HOME), 'utf8');
  for (const page of [HTML, GAMES_PAGE]) {
    assert.equal(/protocol 11|Protocol 11|versions? before|optional donations? of 2\.5/.test(page), false, 'no protocol version or older terms');
  }
  assert.ok(GAMES_PAGE.includes('<s>nodes 4 %</s><s>protocol developers 2 %</s><s>you 2 %</s><s>reserves 2 %</s>'));
  assert.equal(HTML.includes('<section id="proposals"'), false, 'no proposals section on the homepage');
  assert.ok(HTML.includes('<a class="keep" href="https://testnet.bitcoin-arena.io/proposals/">Proposals</a>'))
  //: on a phone the menu keeps Proposals and Docs beside Play - only the section links are hidden
  assert.ok(HTML.includes('<a class="keep" href="https://docs.bitcoin-arena.io/">Docs</a>'));
  assert.match(HTML, /@media \(max-width: 860px\) \{ nav \.links a:not\(\.keep\) \{ display: none; \}/);
  assert.ok(!/nav \.links \{ display: none; \}/.test(HTML), 'the phone menu hides every link again');
  const FORUM = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/proposals/index.html', import.meta.url), 'utf8');
  const JS = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/proposals/forum.js', import.meta.url), 'utf8');
  for (const t of ['bonds at least 3 months old that stay locked at least 3 months after the vote', '60% of the votes say YES, and YES is at least 20% of everyone who could vote',
    'at most 10% of the reserves per proposal, 25% per 3 months', 'Project improvement proposals', 'ALWAYS THE IN-GAME KEY AND NAME', '<script src="/proposals/forum.js" defer></script>']) assert.ok(FORUM.includes(t), t);
  assert.match(JS, /BLWPCLIENT\.forumIdentity\(best\.hex/, 'signs with the in-game identity key of the kept wallet phrase (PIP)');
  assert.match(JS, /'PIP-' \+ p\.pip/, 'every proposal is a PIP');
  // only the in-game key and name (2026-10-17: "Proposals always use the ingame key and name, no other options")
  for (const gone of ['nsec', 'Use a new key', 'Forget this key', 'Save name']) assert.ok(!FORUM.includes(gone), gone);
  assert.ok(!/keyOfNsec|newProposalKey|kind: 'name'/.test(JS), 'the forum offers no other key and sets no name');
  // the reserves' balance first on the page (2026-10-17: "Proposals page shows the current balance on top")
  assert.ok(FORUM.indexOf('id="balance"') > 0 && FORUM.indexOf('id="balance"') < FORUM.indexOf('<h1>'), 'the balance sits above the title');
  assert.match(JS, /function showBalance\(\)/);
  assert.match(JS, /verify: window\.BLWP_CURVE\.verify/, 'names are checked by the page, not taken from a node');
  assert.match(JS, /localStorage\.getItem\('arena\.seeds'\)/);
  assert.match(JS, /var CAP_PCT = 10;/);
  assert.match(JS, /it could never be paid/, 'an amount over 10 % of the reserves is refused before posting');
  assert.match(readFileSync(new URL('proposals/index.html', HOME), 'utf8'), /url=https:\/\/testnet\.bitcoin-arena\.io\/proposals\//, 'bitcoin-arena.io/proposals sends readers there');
});

// A PIP'S FIELDS (2026-10-17: "Separate title field. Content on what the proposal does, in markdown including tables.
// Separate text field how does it improve bitcoin arena"): kept in the one signed purpose, read back apart; the Markdown is safe
test('title, content and "how it improves Bitcoin Arena" round-trip through the purpose; Markdown tables render, HTML does not', () => {
  const JS = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/proposals/forum.js', import.meta.url), 'utf8');
  const FORUM = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/proposals/index.html', import.meta.url), 'utf8');
  const src = JS.slice(JS.indexOf("  var IMPROVES = "), JS.indexOf('  window.ARENA_FORUM_MD = markdown;'));
  const { parts, purposeOf, markdown } = new Function(src + '\nreturn { parts, purposeOf, markdown };')();
  const purpose = purposeOf('A second relay', '## Plan\n\n| item | sat |\n|---|---:|\n| server | 800 |\n| domain | 200 |\n\n- **fast** and `cheap`', 'Faster joins for every game.');
  assert.deepEqual(parts(purpose), { title: 'A second relay', content: '## Plan\n\n| item | sat |\n|---|---:|\n| server | 800 |\n| domain | 200 |\n\n- **fast** and `cheap`', improves: 'Faster joins for every game.' });
  assert.deepEqual(parts('Old style title\nall of this is content'), { title: 'Old style title', content: 'all of this is content', improves: '' }, 'an older proposal');
  const html = markdown(parts(purpose).content);
  assert.match(html, /<table><thead><tr><th>item<\/th><th>sat<\/th><\/tr><\/thead><tbody><tr><td>server<\/td><td>800<\/td><\/tr><tr><td>domain<\/td><td>200<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<h4>Plan<\/h4>/); assert.match(html, /<li><b>fast<\/b> and <code>cheap<\/code><\/li>/);
  const evil = markdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://bitcoin-arena.io)\n\n| <b>a</b> |\n|---|\n| <script> |');
  assert.ok(!/<img|<script|<b>a|href="javascript/.test(evil), evil);
  assert.match(evil, /href="https:\/\/bitcoin-arena\.io"/);
  for (const t of ['Title', 'What the proposal does', 'How it improves Bitcoin Arena', 'of 4,000 characters']) assert.ok(JS.includes(t), t);
  assert.match(FORUM, /PIPs improve Bitcoin Arena as a whole: its games, its protocol/);
});

// THE LOGO, TOP LEFT (2026-10-17: "show the Bitcoin arena logo on the left on Testnet.bitcoin-arena.io and that link
// goes to the main page"): first in the games screen's bar, to bitcoin-arena.io; the old in-page "← bitcoin-arena.io" link is gone
test('the Bitcoin Arena logo is the first thing in the games screen\'s bar and links to bitcoin-arena.io', () => {
  const bar = GAMES.slice(GAMES.indexOf('<div id="arena-wallet-bar"'), GAMES.indexOf('</div>', GAMES.indexOf('<div id="arena-wallet-bar"')));
  assert.match(bar, /^<div id="arena-wallet-bar"[^>]*>\s*<a id="arena-wb-home" href="https:\/\/bitcoin-arena\.io\/"/);
  assert.match(GAMES, /body\.arena-picking #arena-wb-home, body\.arena-own-client #arena-wb-home \{ display: inline-flex;/);
  // and in every game (2026-10-17): Tick Tock's header starts with the mark; no "build your own" anywhere on the page
  assert.match(GAMES, /<div id="arena-money">\s*<a id="arena-game-home" href="https:\/\/bitcoin-arena\.io\/"/);
  assert.ok(!/why-build|Build your own|Build a game or a market|Build &amp; earn/.test(GAMES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')), 'build-your-own is gone');
  assert.match(GAMES, /<div class="foot-row"><span class="build-line">[^<]*<\/span><button type="button" class="donate-btn"/);
  assert.ok(!GAMES.includes('class="home-back"'), 'the old link is gone');
});
