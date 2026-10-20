// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LOGOUT OPENS THE START SCREEN, NOT A NEW ACCOUNT (2026-10-11: "Logout goes straight into a newly
// created account. It must go to an overview with the options to create a new account or log in. On Nostr logout, clear
// the local login."). Measured in Chrome on the page: after a delete and its reload the tab held a freshly minted phrase -
// the wallet bar's and the collect's seed reads minted one before the start screen looked, and with Settings open a timer
// minted one between the delete and the reload. On the page's own code: the start screen is decided once, right after the
// seed keeper; nothing mints behind it; a delete marks the tab account-less until the reload; the Nostr login and its
// wallet connection are forgotten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 50)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const A = 'aa'.repeat(32);

const DECIDE = slice('    try { window.ARENA_NO_SEED_AT_START = ', "window.ARENA_WALLET_SCREEN.done);\n");
const WALLET_SEED = slice('    const walletSeed = () => {', '\n    };\n');
const COLLECT_SEED = slice('    function collectSeed() {', '\n    }\n');
const DELETE = HTML.slice(HTML.indexOf('    window.ARENA_DELETE_ACCOUNT = () => {'), HTML.indexOf('\n    (function accountCard() {'));

function decided(seed) {
  const S = store(); if (seed) S.setItem('arena.player.seed', seed);
  const window = {};
  pageFunction(PAGE, ['window', 'sessionStorage'], DECIDE, 'return 0;')(window, S);
  return window;
}

test('the start screen is decided right after the seed keeper: no phrase in the tab, the start screen; one, the game', () => {
  const none = decided(null);
  assert.equal(none.ARENA_NO_SEED_AT_START, true);
  assert.equal(none.ARENA_START_PENDING(), true, 'pending until the player picks a way in');
  none.ARENA_WALLET_SCREEN = { shown: true, done: true };
  assert.equal(none.ARENA_START_PENDING(), false, 'and over once the start screen is done');
  assert.equal(decided(A).ARENA_NO_SEED_AT_START, false);
  assert.equal(decided(A).ARENA_START_PENDING(), false);
  // the start screen reads that decision, not what the tab holds by the time it runs
  assert.match(HTML, /const already = window\.ARENA_NO_SEED_AT_START === undefined \? !!held : !window\.ARENA_NO_SEED_AT_START;/);
  assert.ok(HTML.indexOf('window.ARENA_NO_SEED_AT_START = !/') < HTML.indexOf('const walletSeed = () => {'), 'decided before any seed read is defined');
});

test('nothing mints a phrase behind the start screen: the wallet bar\'s and the collect\'s seed reads answer none', () => {
  for (const [name, src, ret] of [['walletSeed', WALLET_SEED, 'return walletSeed;'], ['collectSeed', COLLECT_SEED, 'return collectSeed;']]) {
    let minted = 0;
    const ARENACLIENT = { tabSeed: () => { minted++; return new Uint8Array(32); } };
    const window = { ARENA_START_PENDING: () => true };
    const read = pageFunction(PAGE, ['window', 'ARENACLIENT', 'crypto'], src, ret)(window, ARENACLIENT, { getRandomValues: (a) => a });
    assert.equal(read(), null, `${name} behind the start screen`);
    assert.equal(minted, 0, `${name} minted a phrase behind the start screen`);
    window.ARENA_START_PENDING = () => false;
    assert.ok(read() instanceof Uint8Array, `${name} once a way in was picked`);
    assert.equal(minted, 1);
  }
});

test('logout: the tab has no account until its reload, and the Nostr login and its wallet connection are forgotten', () => {
  const L = store(), S = store(), local = store();
  L.setItem('arena.seeds', JSON.stringify([{ hex: A, from: 'imported', at: 1 }]));
  local.setItem('arena.nostr', '{"npub":"npub1x"}'); local.setItem('arena.nwc', 'nostr+walletconnect://x');
  S.setItem('arena.player.seed', A);
  const window = { ARENA_UNITY_LOBBY: { showing: true }, ARENA_NO_SEED_AT_START: false, ARENA_WALLET_SCREEN: { shown: false, done: true } };
  pageFunction(PAGE, ['window', 'sessionStorage'], DECIDE, 'return 0;')(window, S);
  window.ARENA_WALLET_SCREEN = { shown: false, done: true };
  assert.equal(window.ARENA_START_PENDING(), false, 'a player with an account');
  window.ARENA_BROWSER_STORE = () => local;   // the page's one door to the browser's store
  const del = pageFunction(PAGE, ['window', 'vault', 'sessionStorage', 'localStorage', 'ARENACLIENT', 'console'], DELETE, 'return window.ARENA_DELETE_ACCOUNT;')(
    window, () => L, S, local, { forgetPhrase: () => 3 }, { log: () => {} });
  assert.deepEqual(del(), { ok: true, forgot: 3 });
  assert.equal(window.ARENA_START_PENDING(), true, 'from the delete to the reload nothing may mint a new account');
  assert.deepEqual([local.getItem('arena.nostr'), local.getItem('arena.nwc')], [null, null]);
  assert.equal(S.getItem('arena.player.seed'), null);
  assert.equal(S.getItem('arena.wallet.fresh'), '1');
});
