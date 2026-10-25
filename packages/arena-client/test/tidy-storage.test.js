// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OLD WALLET DATABASES OUT OF THE BROWSER'S STORAGE (kanban #616, 2026-10-24: an order refused with "exceeded the quota"; "You need
// to clean up old storages"). tidyStorage removes a database no kept phrase can open, and one of another kept phrase that its merge
// emptied; this tab's own, one with money (not noted empty), one another tab plays with, and one of a federation not named stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyStorage, phraseWalletEntries, walletSecretFor, seedRecovers } from '../src/page-lock.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, map: m }; };
const CUR = 'c0'.repeat(32), EMPTY = 'e0'.repeat(32), RICH = 'a0'.repeat(32), BUSY = 'b0'.repeat(32), GONE = 'd0'.repeat(32);
const FED = 'f0'.repeat(32), OTHER = 'f1'.repeat(32);
const dbOf = (hex, fed = FED) => `arena.walletdb.${fed.slice(0, 16)}.${toHex(sha256(walletSecretFor(fromHex(hex), fromHex(fed)))).slice(0, 16)}.`;
const count = (L, hex, fed = FED) => [...L.map.keys()].filter((k) => k.startsWith(dbOf(hex, fed))).length;

test('a database no kept phrase opens, and another phrase\'s emptied one, go; this tab\'s, one with money, one another tab plays with stay', () => {
  const L = store();
  L.setItem(`arena.ledger.${FED}`, '[]');
  for (const h of [CUR, EMPTY, RICH, BUSY, GONE]) for (let i = 0; i < 4; i++) L.setItem(dbOf(h) + 'k' + i, 'v'.repeat(100));
  for (let i = 0; i < 3; i++) L.setItem(dbOf(GONE, OTHER) + 'k' + i, 'v');   // a federation this tab does not name: left alone
  for (const h of [EMPTY, BUSY]) L.setItem(`arena.wallet.empty.${FED.slice(0, 16)}.${h.slice(0, 16)}`, String(phraseWalletEntries(L, h, FED)));
  L.setItem(`arena.wallet.empty.${FED.slice(0, 16)}.${CUR.slice(0, 16)}`, String(phraseWalletEntries(L, CUR, FED)));
  const r = tidyStorage(L, { seeds: [CUR, EMPTY, RICH, BUSY], current: CUR, federations: [FED], held: (h) => h === BUSY });
  assert.equal(r.wallets, 2); assert.equal(r.removed, 8); assert.ok(r.bytes > 1600);
  assert.equal(count(L, GONE), 0, 'no kept phrase opens it');
  assert.equal(count(L, EMPTY), 0, 'merged and noted empty');
  assert.equal(seedRecovers(L, fromHex(EMPTY)), true, 'should money ever reach it, it is recovered');
  assert.equal(count(L, CUR), 4, 'this tab\'s own wallet is never touched');
  assert.equal(count(L, RICH), 4, 'not noted empty: its money waits for the merge');
  assert.equal(count(L, BUSY), 4, 'another tab plays with it');
  assert.equal(count(L, GONE, OTHER), 3, 'a federation not named here');
});

test('a wallet that changed after it was noted empty stays (its entry count no longer matches)', () => {
  const L = store();
  L.setItem(`arena.ledger.${FED}`, '[]');
  for (let i = 0; i < 4; i++) L.setItem(dbOf(EMPTY) + 'k' + i, 'v');
  L.setItem(`arena.wallet.empty.${FED.slice(0, 16)}.${EMPTY.slice(0, 16)}`, '3');
  assert.equal(tidyStorage(L, { seeds: [CUR, EMPTY], current: CUR }).wallets, 0);
  assert.equal(count(L, EMPTY), 4);
});

test('a collected round\'s lock wallet goes once its collect is done and an hour old; an open or fresh one stays (kanban #625 follow-up)', () => {
  const L = store(); const NOW = 10_000_000;
  const lockdb = (r) => `arena.lockdb.${r.slice(0, 16)}.${'ab'.repeat(8)}.`;
  const R1 = '11'.repeat(32), R2 = '22'.repeat(32), R3 = '33'.repeat(32);
  for (const r of [R1, R2, R3]) for (let i = 0; i < 36; i++) L.setItem(lockdb(r) + 'k' + i, 'v'.repeat(1000));
  L.setItem(`arena.collect.${R1}`, JSON.stringify({ roundIdHex: R1, done: 'collected', savedMs: NOW - 2 * 3600000 }));
  L.setItem(`arena.collect.${R2}`, JSON.stringify({ roundIdHex: R2, done: null, savedMs: NOW - 2 * 3600000 }));
  L.setItem(`arena.collect.${R3}`, JSON.stringify({ roundIdHex: R3, done: 'collected', savedMs: NOW - 60000 }));
  const r = tidyStorage(L, { seeds: [CUR], current: CUR, now: () => NOW });
  const left = (x) => [...L.map.keys()].filter((k) => k.startsWith(lockdb(x))).length;
  assert.deepEqual([left(R1), left(R2), left(R3)], [0, 36, 36]);
  assert.equal(r.removed, 36); assert.ok(r.bytes > 36 * 2000);
  assert.ok(L.getItem(`arena.collect.${R1}`), 'the collect record itself stays');
});
