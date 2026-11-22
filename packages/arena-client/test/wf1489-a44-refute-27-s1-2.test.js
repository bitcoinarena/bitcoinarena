// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2148 (#1489 a44 refute 27): the #1641 case still holds - a record of a phrase a LIVE tab holds (its Web Lock arena.phrase.<16>)
// is left alone, never received into the asking tab's wallets; once that phrase is free it is finished under its lock with ITS OWN wallets
// (walletForPhrase), which are closed (leavePhrase) before the lock goes. Without a lock list another phrase's record is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';

const FROM = 'aa'.repeat(32), TO = 'bb'.repeat(32);
const P1 = '5555aaaa6666bbbb' + 'c'.repeat(48), P2 = '7777dddd8888eeee' + 'f'.repeat(48);
function shared() { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; }
const wallet = (name) => { const w = { name, received: [], sent: 0 };
  w.sendEcash = async (msat) => { w.sent += Number(msat); return JSON.stringify({ msat: Number(msat), ecash: `fedimint-${name}` }); };
  w.receiveEcash = async (e) => { w.received.push(e); return JSON.stringify({ state: 'Success', msat: 50000 }); };
  return w; };

async function handed() {
  const L = shared();
  let seatAnswers = false;
  const fetcher = async (url, o = {}) => {
    if (!o.method) return new Response(JSON.stringify({ holds: { [TO]: '10000000' }, maxMsat: '10000000' }), { status: 200 });
    if (!seatAnswers) throw new Error('The operation was aborted due to timeout');
    return new Response(JSON.stringify({ ecash: 'fedimint-seat-answer', msat: '50000' }), { status: 200 });
  };
  const A = { [FROM]: wallet('P1-from'), [TO]: wallet('P1-to') };
  const t0 = Date.now();
  await exchangeEcashInto({ storage: L, from: FROM, to: TO, needMsat: 50000n, seats: ['http://seat.test'], walletFrom: A[FROM], walletTo: async () => A[TO], fetcher, nowMs: t0, timeoutMs: 30, phrase16: P1 });
  const key = [...L.m.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  assert.equal(readEcashTransfer(L, key).state, 'handed');
  seatAnswers = true;
  return { L, key, fetcher, t0 };
}

test('a phrase a live tab holds: its record is left alone; once free it is finished into that phrase\'s own wallets', async () => {
  const { L, key, fetcher, t0 } = await handed();
  const mineB = { [FROM]: wallet('P2-from'), [TO]: wallet('P2-to') };
  const ownP1 = { [FROM]: wallet('P1own-from'), [TO]: wallet('P1own-to') };
  const left = [];
  const ask = (dt) => resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async (fid) => mineB[fid], fetcher, seats: [], nowMs: t0 + dt,
    phrase16: P2.slice(0, 16), walletForPhrase: async (h16, fid) => { assert.equal(h16, P1.slice(0, 16)); return ownP1[fid]; }, leavePhrase: (h16) => left.push(h16) });
  // TAB A STILL PLAYS P1: it holds the phrase lock
  let release; const held = new Promise((r) => { release = r; });
  let got; const gotIt = new Promise((r) => { got = r; });
  const holder = navigator.locks.request('arena.phrase.' + P1.slice(0, 16), async () => { got(); await held; });
  await gotIt;
  const whileHeld = await ask(60000);
  assert.deepEqual(whileHeld, []);
  assert.equal(readEcashTransfer(L, key).state, 'handed', 'a phrase a live tab holds is left to that tab (#1641)');
  assert.deepEqual([...mineB[TO].received, ...mineB[FROM].received, ...ownP1[TO].received], []);
  release(); await holder;
  // TAB A CLOSED: P1 is free
  const rows = await ask(120000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true, JSON.stringify(rows));
  assert.deepEqual(ownP1[TO].received, ['fedimint-seat-answer'], 'received into P1\'s own wallet');
  assert.deepEqual([...mineB[TO].received, ...mineB[FROM].received], [], 'never into the asking tab\'s');
  assert.deepEqual(left, [P1.slice(0, 16)], 'P1\'s wallets closed before its lock went');
  assert.equal(L.getItem(key), null);
});

test('no lock list: another phrase\'s record is left alone', async () => {
  const { L, key, fetcher, t0 } = await handed();
  const mineB = { [FROM]: wallet('P2-from'), [TO]: wallet('P2-to') };
  const rows = await resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async (fid) => mineB[fid], fetcher, seats: [], nowMs: t0 + 60000,
    phrase16: P2.slice(0, 16), locks: null });
  assert.deepEqual(rows, []);
  assert.equal(readEcashTransfer(L, key).state, 'handed');
  assert.deepEqual(mineB[TO].received, []);
});
