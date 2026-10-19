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
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 50)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };

test('Create makes the wallet and goes straight on: no 24-word dialog is opened', () => {
  const CREATE = slice("      $('ws-new').onclick = () => {", '\n      };\n');
  const els = {}; const clicked = [];
  const $ = (id) => (els[id] = els[id] || { id, style: {}, click: () => clicked.push(id) });
  const box = $('arena-wallet-start'); box.style.display = 'flex';
  const window = { ARENA_WALLET_SCREEN: { shown: true }, sessionStorage: {}, ARENA_SEED_KEEPER: { beat: () => clicked.push('beat') } };
  let minted = 0;
  const BLWPCLIENT = { tabSeed: () => { minted++; return new Uint8Array(32); } };
  const done = () => { box.style.display = 'none'; window.ARENA_WALLET_SCREEN.done = true; };
  pageFunction(PAGE, ['$', 'window', 'BLWPCLIENT', 'crypto', 'busy', 'done'], CREATE, 'return 0;')($, window, BLWPCLIENT, { getRandomValues: (a) => a }, () => {}, done);
  els['ws-new'].onclick();
  assert.equal(minted, 1, 'the wallet is made');
  assert.equal(box.style.display, 'none', 'the start screen is done');
  assert.deepEqual(clicked, ['beat'], 'and no seed dialog is opened');
  assert.match(HTML, /Create a new wallet<small>Ready at once - back up its 24 words any time in Settings<\/small>/);
});

test('a Nostr login shows no words after its reload', () => {
  assert.doesNotMatch(HTML, /setItem\('arena\.nostr\.showWords'/, 'nothing asks for the words after a login');
  assert.doesNotMatch(HTML, /if \(words && already\)/);
});

test('Settings keeps the 24 words and their check; the lobby\'s backup line leads there', () => {
  assert.match(HTML, /<button id="arena-phrase-show"[^>]*>Show seed phrase<\/button>/);
  assert.ok(HTML.includes('id="arena-verify-start"'), 'the check of the words');
  assert.ok(HTML.includes("document.getElementById('arena-backup-cta').addEventListener('click'"), 'the lobby line opens Settings on the words');
});

// (2026-10-17: "when it says back up now and the modal opens there is space for a message explaining why user needs
// to do it. Needs to fit mobile as well"): the reason, above the words, small on a phone
test('the seed modal says why the words must be written down, above them', async () => {
  const { readFileSync } = await import('node:fs');
  const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const box = HTML.slice(HTML.indexOf('<div id="arena-seed-words">'), HTML.indexOf('<div id="arena-verify-step"'));
  assert.ok(box.indexOf('id="arena-seed-why"') > box.indexOf('<h3>Your seed phrase</h3>') && box.indexOf('id="arena-seed-why"') < box.indexOf('id="arena-phrase"'));
  assert.match(box, /These 24 words are your wallet\.<\/b> Your sats are kept only in this browser/);
  assert.match(box, /Never share them: whoever has them can take your sats\./);
  assert.match(HTML, /@media \(max-width: 420px\) \{ #arena-seed-modal \.seed-why \{ font-size: 12\.5px;/);
});
