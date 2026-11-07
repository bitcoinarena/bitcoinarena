// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OLD WALLET DATABASES OUT OF THE BROWSER'S STORAGE (kanban #616, 2026-10-24: an order refused with "exceeded the quota"; "You need
// to clean up old storages"). tidyStorage removes a database no kept phrase can open, and one of another kept phrase that its merge
// emptied; this tab's own, one with money (not noted empty), one another tab plays with, and one of a federation not named stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyStorage, phraseWalletEntries, walletSecretFor, seedRecovers, lockStoreFor, onStorageFull, lockSecretFor } from '../src/page-lock.js';
import { readFileSync } from 'node:fs';
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
  // each round's wallet as lockStoreFor names it: the phrase's and the round's (kanban #1265: the tidy reads which records are that wallet's)
  const lockdb = (r) => `arena.lockdb.${r.slice(0, 16)}.${toHex(sha256(lockSecretFor(fromHex(CUR), fromHex(r)))).slice(0, 16)}.`;
  const R1 = '11'.repeat(32), R2 = '22'.repeat(32), R3 = '33'.repeat(32), R4 = '44'.repeat(32);
  for (const r of [R1, R2, R3, R4]) for (let i = 0; i < 36; i++) L.setItem(lockdb(r) + 'k' + i, 'v'.repeat(1000));
  // DONE WITH ITS ROUND WALLET READ EMPTY (kanban #1163: markCollectDone writes tabMsat '0'); a done an older page wrote stays until the browser is full
  L.setItem(`arena.collect.${R1}`, JSON.stringify({ roundIdHex: R1, seed: CUR, done: { payout: 'collected', stake: null, tabMsat: '0' }, savedMs: NOW - 2 * 3600000 }));
  L.setItem(`arena.collect.${R4}`, JSON.stringify({ roundIdHex: R4, seed: CUR, done: 'collected', savedMs: NOW - 2 * 3600000 }));
  L.setItem(`arena.collect.${R2}`, JSON.stringify({ roundIdHex: R2, seed: CUR, done: null, savedMs: NOW - 2 * 3600000 }));
  L.setItem(`arena.collect.${R3}`, JSON.stringify({ roundIdHex: R3, seed: CUR, done: 'collected', savedMs: NOW - 60000 }));
  const r = tidyStorage(L, { seeds: [CUR], current: CUR, now: () => NOW });
  const left = (x) => [...L.map.keys()].filter((k) => k.startsWith(lockdb(x))).length;
  assert.deepEqual([left(R1), left(R2), left(R3), left(R4)], [0, 36, 36, 36]);
  assert.equal(r.removed, 36); assert.ok(r.bytes > 36 * 2000);
  assert.ok(L.getItem(`arena.collect.${R1}`), 'the collect record itself stays');
});

test('a full browser: what the seed can give back goes, the playing wallet, money and deposits on their way stay (the owner 2026-10-30, 19 kept phrases, "exceeded the quota")', () => {
  const fake = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
  const L = fake();
  const FED2 = 'cd'.repeat(32);
  const CUR2 = '11'.repeat(32), IDLE = '22'.repeat(32), RICH2 = '33'.repeat(32), PLAYING = '44'.repeat(32), WAITING = '55'.repeat(32);
  const db = (hex, fed) => `arena.walletdb.${fed.slice(0, 16)}.${toHex(sha256(walletSecretFor(fromHex(hex), fromHex(fed)))).slice(0, 16)}.`;
  const big = 'x'.repeat(400000);
  for (const hex of [CUR2, IDLE, RICH2, PLAYING]) L.setItem(db(hex, FED2) + '2f', big);
  L.setItem(`arena.wallet.known.${FED2.slice(0, 16)}.${RICH2.slice(0, 16)}`, '1000000');
  const FED3 = 'ef'.repeat(32);
  L.setItem(db(WAITING, FED3) + '2f', big);
  L.setItem(`arena.deposit.pending.${FED3}`, JSON.stringify([{ operation: 'op', invoice: 'lntb', msat: '1000000' }]));
  // a done round read empty (kanban #1265: its records name the phrase, and the wallet is the one lockStoreFor names for it)
  const doneDb = 'arena.lockdb.' + 'aa'.repeat(8) + '.' + toHex(sha256(lockSecretFor(fromHex(CUR2), fromHex('aa'.repeat(32))))).slice(0, 16) + '.';
  L.setItem(doneDb + '1', big);
  L.setItem('arena.collect.x', JSON.stringify({ done: { payout: 'collected', stake: null, tabMsat: '0' }, seed: CUR2, roundIdHex: 'aa'.repeat(32), savedMs: Date.now() }));
  L.setItem('arena.lockdb.' + 'cc'.repeat(8) + '.' + 'bb'.repeat(8) + '.1', big);
  const r = tidyStorage(L, { seeds: [CUR2, IDLE, RICH2, PLAYING, WAITING], current: CUR2, federations: [FED2, FED3], held: (h) => h === PLAYING, pressureChars: 1000000 });
  assert.equal(L.getItem(db(IDLE, FED2) + '2f'), null, 'an idle phrase with no known balance goes');
  assert.equal(seedRecovers(L, fromHex(IDLE)), true, 'and reads itself back from the federation at its next open');
  assert.equal(L.getItem(doneDb + '1'), null, 'a done round\'s lock wallet, read empty, goes, even under an hour old');
  assert.ok(L.getItem(db(CUR2, FED2) + '2f'), 'the playing wallet stays');
  assert.ok(L.getItem(db(RICH2, FED2) + '2f'), 'a wallet with a known balance stays');
  assert.ok(L.getItem(db(PLAYING, FED2) + '2f'), 'a phrase another tab plays with stays');
  assert.equal(L.getItem(db(WAITING, FED3) + '2f'), null, 'a deposit on its way holds only the wallet that made it (kanban #803)');
  assert.ok(L.getItem('arena.lockdb.' + 'cc'.repeat(8) + '.' + 'bb'.repeat(8) + '.1'), 'an open round\'s lock wallet stays');
  assert.ok(r.bytes > 0);
});

test('below the pressure line nothing more goes', () => {
  const m = new Map([[`arena.walletdb.${'cd'.repeat(8)}.${'00'.repeat(8)}.2f`, 'x']]);
  const L = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  assert.equal(tidyStorage(L, { seeds: ['11'.repeat(32)], current: '11'.repeat(32), federations: [], pressureChars: 3500000 }).removed, 0);
});

test('a write refused for room frees storage and goes in; with no room to free it still throws, and another error is not swallowed (the owner 2026-10-30)', async () => {
  const { putRoomy, onStorageFull } = await import('../src/page-lock.js');
  let full = true, freed = 0;
  const q = () => Object.assign(new Error('exceeded the quota'), { name: 'QuotaExceededError' });
  const m = new Map(), L = { setItem(k, v) { if (full) throw q(); m.set(k, v); } };
  onStorageFull(() => { freed++; full = false; });
  putRoomy(L, 'a', '1');
  assert.equal(m.get('a'), '1'); assert.equal(freed, 1);
  full = true; onStorageFull(() => {});
  assert.throws(() => putRoomy(L, 'b', '2'), /quota/);
  const bad = { setItem() { throw new Error('another'); } };
  let asked = 0; onStorageFull(() => { asked++; });
  assert.throws(() => putRoomy(bad, 'c', '3'), /another/); assert.equal(asked, 0);
  onStorageFull(null);
});

// NEVER TAKEN OVER (kanban #1164, the 2026-11-06 audit): 2026-10-30 stole a lock after two minutes without a heartbeat, and a hidden tab that
// still held it ran its wallet client on beside the merge's - a lock with no fresh heartbeat is asked of its tab like any other
test('a phrase lock with no heartbeat for two minutes is never taken over: its tab is asked over BroadcastChannel like any other (kanban #1164)', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const at = src.indexOf('A LOCK IS NEVER TAKEN OVER');
  const ask = src.indexOf("is open in another tab - asking that tab to hand its money over", at);
  assert.ok(at > 0 && ask > at, 'the merge does not say a lock is never taken over before it asks the tab');
  assert.doesNotMatch(src, /locks\.request\([^;]*steal:\s*true/);
});

test('past its room a lock wallet goes on in memory, whole, and the browser\'s refusal never reaches the lock client (kanban #803)', () => {
  const full = store();
  full.setItem('other', 'x'.repeat(1600000));
  const a = lockStoreFor(full, fromHex('a1'.repeat(32)), fromHex('b1'.repeat(32)));
  a.put('k', 'v');
  assert.deepEqual(JSON.parse(a.entries()), [['k', 'v']]);
  assert.equal([...full.map.keys()].filter((k) => k.startsWith('arena.lockdb.')).length, 0);
  a.remove('k'); assert.deepEqual(JSON.parse(a.entries()), []);
  // kept so far, then refused: all of it moves to memory, no part stays behind
  const L = store(), setItem = L.setItem; let refuse = false;
  L.setItem = (k, v) => { if (refuse) throw Object.assign(new Error('exceeded the quota'), { name: 'QuotaExceededError' }); return setItem(k, v); };
  onStorageFull(() => {});
  const b = lockStoreFor(L, fromHex('a2'.repeat(32)), fromHex('b2'.repeat(32)));
  b.put('one', '1'); refuse = true; b.put('two', '2');
  assert.deepEqual(JSON.parse(b.entries()).sort(), [['one', '1'], ['two', '2']]);
  assert.equal([...L.map.keys()].filter((k) => k.startsWith('arena.lockdb.')).length, 0);
  onStorageFull(null);
});

test('under pressure an open round\'s old lock wallet goes; a recent one and one a client of this page holds stay (kanban #803)', () => {
  const L = store(), now = 1e13, db = (r) => `arena.lockdb.${r.repeat(16)}.${'0'.repeat(16)}.`;
  L.setItem(`arena.ledger.${FED}`, '[]');
  for (const r of ['a', 'b']) L.setItem(db(r) + 'k', 'v'.repeat(1000));
  L.setItem('arena.collect.b', JSON.stringify({ roundIdHex: 'b'.repeat(64), savedMs: now - 1000 }));
  const live = lockStoreFor(L, fromHex('c3'.repeat(32)), fromHex('d3'.repeat(32)));
  live.put('k', 'v'.repeat(1000));
  const kept = [];
  tidyStorage(L, { seeds: [CUR], current: CUR, federations: [FED], now: () => now, pressureChars: 10, archive: (rows) => { kept.push(...rows); } });
  assert.equal(L.getItem(db('a') + 'k'), null, 'old and open: out of this storage');
  assert.deepEqual(kept.map(([k]) => k), [db('a') + 'k'], 'and handed over whole, nothing lost');
  assert.notEqual(L.getItem(db('b') + 'k'), null, 'kept within the hour');
  assert.equal(JSON.parse(live.entries()).length, 1, 'a client of this page holds it');
});

test('a deposit waiting holds the wallet whose keys name it, not every wallet of its federation (kanban #803)', () => {
  const L = store();
  const op = 'ab'.repeat(32), HOLDER = '66'.repeat(32), IDLE2 = '77'.repeat(32);
  L.setItem(dbOf(CUR) + '2f', 'x'.repeat(100));
  L.setItem(dbOf(HOLDER) + '30' + op, 'x'.repeat(100));
  L.setItem(dbOf(IDLE2) + '2f', 'x'.repeat(100));
  L.setItem(`arena.deposit.pending.${FED}`, JSON.stringify([{ operation: op, invoice: 'lntb', msat: '1000000' }]));
  tidyStorage(L, { seeds: [CUR, HOLDER, IDLE2], current: CUR, federations: [FED], pressureChars: 10 });
  assert.equal(count(L, IDLE2), 0, 'an idle wallet of that federation goes');
  assert.equal(count(L, HOLDER), 1, 'the wallet that made the deposit stays');
  assert.equal(count(L, CUR), 1, 'the playing wallet stays');
});


// KANBAN #1265 (audit 4 #1257 CLIENT-1): the lock wallet is the phrase's and the round's - every order of the phrase shares it - and it went once ANY record
// of its round was done (an hour later, or at once under pressure), with another order's collected e-cash in it; and under pressure an open round's wallet
// went to an archive nothing reads. Now a wallet goes only when every record that maps to it is done with the wallet read empty.
test('#1265 a lock wallet two orders share stays while one of them is open, normally and under pressure; it goes once both are done and empty', () => {
  const NOW = 10_000_000, R = '55'.repeat(32);
  const wallet = `arena.lockdb.${R.slice(0, 16)}.${toHex(sha256(lockSecretFor(fromHex(CUR), fromHex(R)))).slice(0, 16)}.`;
  const setUp = (order1Done) => {
    const L = store();
    L.setItem(`arena.ledger.${FED}`, '[]');
    for (let i = 0; i < 4; i++) L.setItem(wallet + 'k' + i, 'v'.repeat(1000));
    L.setItem(`arena.collect.${R}.o0`, JSON.stringify({ roundIdHex: R, seed: CUR, order: 0, done: { payout: 'collected', stake: null, tabMsat: '0' }, savedMs: NOW - 2 * 3600000 }));
    L.setItem(`arena.collect.${R}.o1`, JSON.stringify({ roundIdHex: R, seed: CUR, order: 1, done: order1Done ? { payout: 'collected', stake: null, tabMsat: '0' } : null, savedMs: NOW - 2 * 3600000 }));
    return L;
  };
  const left = (L) => [...L.map.keys()].filter((k) => k.startsWith(wallet)).length;
  const normal = setUp(false); tidyStorage(normal, { seeds: [CUR], current: CUR, now: () => NOW });
  const archived = [];
  const pressed = setUp(false); tidyStorage(pressed, { seeds: [CUR], current: CUR, federations: [FED], now: () => NOW, pressureChars: 10, archive: (rows) => archived.push(...rows) });
  const both = setUp(true); tidyStorage(both, { seeds: [CUR], current: CUR, now: () => NOW });
  const facts = { order1Open: { normal: left(normal), underPressure: left(pressed), archived: archived.length }, bothDoneEmpty: left(both) };
  console.log('  FACTS #1265 tidy:', JSON.stringify(facts));
  assert.equal(facts.order1Open.normal, 4, 'the wallet went with order 1 still open in it');
  assert.equal(facts.order1Open.underPressure, 4, 'under pressure the wallet went with order 1 still open in it');
  assert.equal(facts.order1Open.archived, 0, 'an open order\'s wallet was archived where nothing reads it');
  assert.equal(facts.bothDoneEmpty, 0, 'a wallet whose every record is done and read empty stays for good');
});
