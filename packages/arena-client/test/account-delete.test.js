// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DELETE THIS ACCOUNT FROM THIS BROWSER (2026-10-11: "Im settings screen gibt es die Möglichkeit seinen
// Account wieder zu löschen um sich mit Nostr oder ähnlich einzuloggen"). Measured on the page's own code and the client's:
// this tab's phrase leaves the tab and the browser's kept list, the wallet data of that phrase goes and no other phrase's,
// the Nostr login is forgotten, nothing is done during a live run, and the reloaded tab takes no other kept phrase - it
// opens on the start screen (Nostr, restore, create) - until it holds a phrase again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { forgetPhrase, phraseWalletEntries, walletSecretFor, markSeedRecover, seedRecovers } from '../src/page-lock.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, map: m }; };
const A = 'aa'.repeat(32), B = 'bb'.repeat(32), FED = 'f0'.repeat(32);
const dbOf = (hex) => `arena.walletdb.${FED.slice(0, 16)}.${toHex(sha256(walletSecretFor(fromHex(hex), fromHex(FED)))).slice(0, 16)}.`;

test('forgetPhrase removes that phrase\'s wallet data and recover mark, and no other phrase\'s', () => {
  const L = store();
  L.setItem(`arena.ledger.${FED}`, '[]');
  for (const [h, n] of [[A, 3], [B, 2]]) for (let i = 0; i < n; i++) L.setItem(dbOf(h) + 'k' + i, 'v');
  markSeedRecover(L, A);
  assert.deepEqual([phraseWalletEntries(L, A), phraseWalletEntries(L, B)], [3, 2]);
  assert.equal(forgetPhrase(L, A), 4, 'three entries and the recover mark');
  assert.deepEqual([phraseWalletEntries(L, A), phraseWalletEntries(L, B)], [0, 2], 'the other phrase\'s wallet stays');
  assert.equal(seedRecovers(L, fromHex(A)), false);
  assert.equal(L.getItem(`arena.ledger.${FED}`), '[]');
  assert.equal(forgetPhrase(L, 'not a phrase'), 0);
});

const from = HTML.indexOf('function arenaSeedKeeper(');
const Keeper = pageFunction(PAGE, [], HTML.slice(from, HTML.indexOf('\n    try {\n      window.ARENA_SEED_KEEPER', from)), '; return arenaSeedKeeper;')();
const open = (L, T) => Keeper({ L, T, now: () => 1e6, every: () => {}, on: () => {}, random: () => 'tab' + Math.random() });

test('the reloaded tab of a deleted account takes no other kept phrase, until it holds one again', () => {
  const L = store();
  L.setItem('arena.seeds', JSON.stringify([{ hex: B, from: 'minted', at: 1 }]));
  const plain = store(); open(L, plain);
  assert.equal(plain.getItem('arena.player.seed'), B, 'a plain new tab takes the free kept phrase');
  const T = store(); T.setItem('arena.wallet.fresh', '1');
  const k = open(L, T);
  assert.equal(T.getItem('arena.player.seed'), null, 'the deleted account\'s tab takes none: the start screen shows');
  T.setItem('arena.player.seed', A); k.beat();       // logged in again (Nostr, restore or create)
  assert.equal(T.getItem('arena.wallet.fresh'), null);
  assert.ok(JSON.parse(L.getItem('arena.seeds')).some((x) => x.hex === A), 'and its phrase is kept as any other');
});

const ACTION = HTML.slice(HTML.indexOf('    window.ARENA_DELETE_ACCOUNT = () => {'), HTML.indexOf('\n    (function accountCard() {'));
function page({ live = false } = {}) {
  const L = store(), S = store(), local = store();
  L.setItem('arena.seeds', JSON.stringify([{ hex: A, from: 'minted', at: 1 }, { hex: B, from: 'minted', at: 2 }]));
  L.setItem('arena.seed.held.' + A.slice(0, 16), '{"tab":"t","at":1}');
  L.setItem('arena.nostr', '{"npub":"npub1x"}'); local.setItem('arena.nostr', '{"npub":"npub1x"}');
  S.setItem('arena.player.seed', A); S.setItem('arena.player.seed.from', 'imported');
  const forgot = [];
  const window = { BLWP_UNITY_LOBBY: { showing: !live } };
  const fn = pageFunction(PAGE, ['window', 'vault', 'sessionStorage', 'localStorage', 'BLWPCLIENT', 'console'], ACTION, 'return window.ARENA_DELETE_ACCOUNT;');
  const del = fn(window, () => L, S, local, { forgetPhrase: (s, h) => { forgot.push(h); return 5; } }, { log: () => {} });
  return { del, L, S, local, forgot };
}

test('delete: this tab\'s phrase, its wallets and the Nostr login are forgotten; another kept phrase stays; refused during a run', () => {
  const p = page();
  assert.deepEqual(p.del(), { ok: true, forgot: 5 });
  assert.deepEqual(p.forgot, [A]);
  assert.equal(p.S.getItem('arena.player.seed'), null);
  assert.equal(p.S.getItem('arena.wallet.fresh'), '1');
  assert.deepEqual(JSON.parse(p.L.getItem('arena.seeds')).map((x) => x.hex), [B], 'only this tab\'s phrase leaves the kept list');
  assert.equal(p.L.getItem('arena.seed.held.' + A.slice(0, 16)), null);
  assert.deepEqual([p.L.getItem('arena.nostr'), p.local.getItem('arena.nostr')], [null, null], 'the Nostr login is forgotten');
  const q = page({ live: true });
  assert.deepEqual(q.del(), { ok: false, why: 'A round is running in this tab - finish it first.' });
  assert.equal(q.S.getItem('arena.player.seed'), A, 'nothing removed during a run');
  assert.deepEqual(q.forgot, []);
});

test('the Account card asks before it deletes: the balance said, "I have my 24 words or my Nostr key" ticked first', () => {
  const card = HTML.slice(HTML.indexOf('<section class="settings-card" id="arena-set-account">'), HTML.indexOf('</section>', HTML.indexOf('id="arena-set-account"')));
  assert.match(card, /Delete this account from this browser/);
  assert.match(card, /<button id="arena-acct-go" type="button" class="primary" disabled>/, 'disabled until the box is ticked');
  assert.match(card, /I have my 24 words or my Nostr key/);
});
