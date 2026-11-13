// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 27 skeptic 2 (#1641 / #2148) - FAILS on bf19b45d5: THE TAB'S OWN STAKE-LOCK EXCHANGE WAITS ON ANOTHER PHRASE'S
// COLD WALLET OPEN, UNBOUNDED, UNDER THAT PHRASE'S LOCK.
//
// ARENA_EXCHANGE_INTO (the stake lock of a paid join, index.html ~4224) awaits resumeEcashExchanges before its own exchange. Before #2148 a
// record of another phrase cost nothing (skipped). Now every free phrase's record opens that phrase's wallets cold (walletForPhrase ->
// openPlayerWallet, no time limit given: joinWaitMs 180 s; the merge races the same open against MERGE_OPEN_MS 10 s) while holding
// arena.phrase.<P1>. A federation of P1's record that does not answer (retired, a guardian set down) holds the player's join - with its
// round's entry closing - for minutes, every exchange, since the record is never decided and is opened afresh each time (leavePhrase).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';

const FROM = 'aa'.repeat(32), TOF = 'bb'.repeat(32);
const P1 = '5656aaaa7878bbbb' + 'c'.repeat(48), P2 = '9090dddd1010eeee' + 'f'.repeat(48);
function shared() { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; }
const wallet = (name) => { const w = { name, received: [], sent: 0 };
  w.sendEcash = async (msat) => { w.sent += Number(msat); return JSON.stringify({ msat: Number(msat), ecash: `fedimint-${name}` }); };
  w.receiveEcash = async (e) => { w.received.push(e); return JSON.stringify({ state: 'Success', msat: 50000 }); };
  return w; };

test('a free phrase whose wallet does not open does not hold this tab\'s exchange (nor its lock) for the open\'s whole 180 s', async () => {
  const L = shared();
  const fetcher = async (url, o = {}) => {
    if (!o.method) return new Response(JSON.stringify({ holds: { [TOF]: '10000000' }, maxMsat: '10000000' }), { status: 200 });
    throw new Error('The operation was aborted due to timeout');
  };
  const A = { [FROM]: wallet('P1-from'), [TOF]: wallet('P1-to') };
  const t0 = Date.now();
  await exchangeEcashInto({ storage: L, from: FROM, to: TOF, needMsat: 50000n, seats: ['http://seat.test'], walletFrom: A[FROM], walletTo: async () => A[TOF], fetcher, nowMs: t0, timeoutMs: 30, phrase16: P1 });
  const key = [...L.m.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  assert.equal(readEcashTransfer(L, key).state, 'handed');
  const B = { [FROM]: wallet('P2-from'), [TOF]: wallet('P2-to') };
  let opens = 0;
  // P1's federation does not answer: openPlayerWallet's join runs its joinWaitMs (180 s; the page passes none)
  const walletForPhrase = () => { opens++; return new Promise(() => {}); };
  const at = Date.now();
  const resumed = resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async (fid) => B[fid], fetcher, seats: [], nowMs: t0 + 60000,
    phrase16: P2.slice(0, 16), takeUnnamed: false, walletForPhrase, leavePhrase: () => {} });
  const out = await Promise.race([resumed.then((rows) => ({ rows })), new Promise((r) => setTimeout(() => r({ hung: true }), 15000))]);
  const lockFree = await navigator.locks.request('arena.phrase.' + P1.slice(0, 16), { ifAvailable: true }, (l) => !!l);
  const facts = { ...out, waitedMs: Date.now() - at, opens, P1lockFree: lockFree };
  console.log('  FACTS a44-refute-27-s2-2:', JSON.stringify(facts));
  assert.ok(!out.hung, `this tab's exchange (the stake lock of its join) still waits on another phrase's wallet open after 15 s, holding arena.phrase.<P1>: ${JSON.stringify(facts)}`);
  assert.ok(lockFree, 'P1\'s lock is let go');
});
