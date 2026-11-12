// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2401, #2470 (#1489 a44 refute 27 s2): another phrase's record that NEEDS its from-wallet (notes taken back after the seat stayed
// silent) and whose wallet never opens: the open is bounded (openMs), the lock and the collecting mark are let go, the record stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX, ECASH_HANDED_RECLAIM_MS } from '../src/ecash-transfer.js';

const FROM = 'aa'.repeat(32), TOF = 'bb'.repeat(32);
const P1 = '3434aaaa5656bbbb' + 'c'.repeat(48), P2 = '7878dddd9090eeee' + 'f'.repeat(48);
function shared() { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; }
const wallet = (name) => { const w = { name };
  w.sendEcash = async (msat) => JSON.stringify({ msat: Number(msat), ecash: `fedimint-${name}` });
  w.receiveEcash = async () => JSON.stringify({ state: 'Success', msat: 50000 });
  return w; };

test('a free phrase\'s take-back whose wallet never opens is bounded: lock and collecting mark let go, the record kept', async () => {
  const L = shared();
  const fetcher = async (url, o = {}) => {
    if (!o.method) return new Response(JSON.stringify({ holds: { [TOF]: '10000000' }, maxMsat: '10000000' }), { status: 200 });
    throw new Error('The operation was aborted due to timeout');
  };
  const A = { [FROM]: wallet('P1-from'), [TOF]: wallet('P1-to') };
  const t0 = Date.now();
  await exchangeEcashInto({ storage: L, from: FROM, to: TOF, needMsat: 50000n, seats: ['http://seat.test'], walletFrom: A[FROM], walletTo: async () => A[TOF], fetcher, nowMs: t0, timeoutMs: 30, phrase16: P1 });
  const key = [...L.m.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  let opens = 0; const held = []; const left = [];
  const at = Date.now();
  const rows = await resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async () => { throw new Error('not this tab\'s'); }, fetcher, seats: [],
    nowMs: t0 + ECASH_HANDED_RECLAIM_MS + 1000, phrase16: P2.slice(0, 16), walletForPhrase: () => { opens++; return new Promise(() => {}); },
    onHold: (h) => { held.push(h); assert.ok(L.getItem('arena.seed.collecting.' + h), 'the collecting mark is written while the lock is held'); },
    leavePhrase: (h, o) => { left.push([h, !!(o && o.late)]); }, openMs: 200 });
  const waitedMs = Date.now() - at;
  const lockFree = await navigator.locks.request('arena.phrase.' + P1.slice(0, 16), { ifAvailable: true }, (l) => !!l);
  console.log('  FACTS a44-refute-27-s2-3:', JSON.stringify({ rows, waitedMs, opens, held, left, lockFree }));
  assert.ok(waitedMs < 3000, `waited ${waitedMs} ms`);
  assert.equal(opens, 1);
  assert.deepEqual(held, [P1.slice(0, 16)]);
  assert.deepEqual(left, [[P1.slice(0, 16), false]]);
  assert.ok(lockFree);
  assert.equal(L.getItem('arena.seed.collecting.' + P1.slice(0, 16)), null, 'the mark goes with the lock');
  assert.equal(readEcashTransfer(L, key).state, 'reclaiming', 'the record stays, to be taken back later');
  assert.equal(rows[0].ok, false); assert.equal(rows[0].pending, true);
});
