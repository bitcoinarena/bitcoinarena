// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEED CHECK IS IN SETTINGS, NOT IN THE FIRST RUN (2026-10-11: "The wallet should be deterministic, so
// showing the seed and forcing a check interrupts the flow. Put the seed display and the mandatory check in settings, as a
// backup."). On the page's own code: Create on the start screen makes the wallet and opens no dialog; a Nostr login shows no
// words after its reload; Settings keeps the 24 words and their check, and the lobby's backup line leads there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const SEED = readFileSync(new URL('../../arena-web/src/arena/SeedModal.jsx', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 50)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };

test('Create makes the wallet and goes straight on: no 24-word dialog is opened', () => {
  // the page's create rule (the wallet screen's panes are React's, kanban #564: arena-web WalletStart)
  const CREATE = slice("      const create = () => {", '\n      };\n');
  const els = {}; const clicked = [];
  const $ = (id) => (els[id] = els[id] || { id, style: {}, click: () => clicked.push(id) });
  const box = $('arena-wallet-start'); box.style.display = 'flex';
  const window = { ARENA_WALLET_SCREEN: { shown: true }, sessionStorage: {}, ARENA_SEED_KEEPER: { beat: () => clicked.push('beat') } };
  let minted = 0;
  const ARENACLIENT = { tabSeed: () => { minted++; return new Uint8Array(32); } };
  const done = () => { box.style.display = 'none'; window.ARENA_WALLET_SCREEN.done = true; };
  const create = pageFunction(PAGE, ['$', 'window', 'ARENACLIENT', 'crypto', 'done'], CREATE, 'return create;')($, window, ARENACLIENT, { getRandomValues: (a) => a }, done);
  assert.deepEqual(create(), { ok: true });
  assert.equal(minted, 1, 'the wallet is made');
  assert.equal(box.style.display, 'none', 'the start screen is done');
  assert.deepEqual(clicked, ['beat'], 'and no seed dialog is opened');
  assert.match(readFileSync(new URL('../../arena-web/src/arena/WalletStart.jsx', import.meta.url), 'utf8'), /Create a new wallet<small>Ready at once - back up its 24 words any time in Settings<\/small>/);
  assert.match(HTML, /window\.ArenaWalletStart\.open\(box, \{\n\s+create,/);
});

test('a Nostr login shows no words after its reload', () => {
  assert.doesNotMatch(HTML, /setItem\('arena\.nostr\.showWords'/, 'nothing asks for the words after a login');
  assert.doesNotMatch(HTML, /if \(words && already\)/);
});

test('Settings keeps the 24 words and their check; the lobby\'s backup line leads there', () => {
  assert.match(readFileSync(new URL('../../arena-web/src/arena/SettingsCards.jsx', import.meta.url), 'utf8'), /<button id="arena-phrase-show" type="button" className="primary" onClick=\{\(\) => this\.props\.onShow\(\)\}>Show seed phrase<\/button>/);
  assert.match(HTML, /backup: backupLine, onShow: showPhrase,/);
  // the words and their check are the React modal's (kanban #564, arena-web SeedModal), opened by the Settings button
  assert.match(HTML, /window\.ArenaSeed\.open\(host, \{ words: made\.ok \? made\.words : \[\]/);
  assert.match(SEED, /onClick=\{\(\) => this\.start\(\)\}>Verify seed phrase<\/button>/, 'the check of the words');
  assert.ok(HTML.includes("document.getElementById('arena-backup-cta').addEventListener('click'"), 'the lobby line opens Settings on the words');
});

// (2026-10-17: "when it says back up now and the modal opens there is space for a message explaining why user needs
// to do it. Needs to fit mobile as well"): the reason, above the words, small on a phone
test('the seed modal says why the words must be written down, above them', async () => {
  const box = SEED.slice(SEED.indexOf('<h3>Your seed phrase</h3>'));
  assert.ok(box.indexOf('className="seed-why"') > 0 && box.indexOf('className="seed-why"') < box.indexOf('className="seed-grid"'), 'the reason above the words');
  assert.match(box, /These 24 words are your wallet\.<\/b> Your sats are kept only in this browser/);
  assert.match(box, /Never share them: whoever has them can take your sats\./);
  assert.match(HTML, /@media \(max-width: 420px\) \{ #arena-seed-modal \.seed-why \{ font-size: 12\.5px;/);
});
