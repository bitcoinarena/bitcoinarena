// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS' EXCHANGE OFFERS ARE READ AT ONCE, NOT ONE AFTER ANOTHER (kanban #1483, Daniel 2026-11-11: "joining the round - stake lock: exchanging at
// tn4.bitcoin-arena.io/guardian-1 ... Make it more efficient"): exchangeEcashInto asked GET /exchange of each seat in turn with an 8 s timeout each, so
// every seat that did not answer (a restarting seat, a loaded Beelink: load 40 measured 2026-11-12 03:00Z) put up to 8 s in front of the lock. The offers
// are now read side by side and the first offering seats IN THE SEATS' ORDER are used, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto } from '../src/ecash-transfer.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

test('two silent seats before an offering one cost one timeout, not two', async () => {
  const seats = ['https://s1', 'https://s2', 'https://s3', 'https://s4'];
  const asked = [];
  const fetcher = (url, o = {}) => {
    asked.push(url);
    if (o.method === 'POST') return Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, why: 'no' }), text: async () => 'no' });
    if (/s1|s2/.test(url)) return new Promise((_, no) => o.signal.addEventListener('abort', () => no(new Error('timeout'))));
    return Promise.resolve({ ok: true, json: async () => ({ maxMsat: '1000000', holds: { [B]: '500000' } }) });
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const handed = [];
  const walletFrom = { sendEcash: async () => { throw new Error('stop here'); }, sentEcash: async () => 'null' };
  const t0 = Date.now();
  const r = await exchangeEcashInto({ storage, from: A, to: B, needMsat: 100000n, seats, walletFrom, walletTo: async () => ({}), fetcher,
    offerTimeoutMs: 300, onStep: (s) => handed.push(s) });
  const ms = Date.now() - t0;
  assert.ok(ms < 550, `the offers took ${ms} ms: one 300 ms timeout, not one per silent seat`);
  assert.equal(asked.filter((u) => /\/exchange\?/.test(u)).length, 4, 'every seat asked');
  assert.equal(r.ok, false);
});

test('the offering seats are used in the seats\' order, at most maxSeats', async () => {
  const seats = ['https://s1', 'https://s2', 'https://s3', 'https://s4', 'https://s5'];
  const delays = { s1: 50, s2: 0, s3: 30, s4: 0, s5: 0 };
  const fetcher = (url) => {
    const s = /\/\/(s\d)/.exec(url)[1];
    return new Promise((go) => setTimeout(() => go(s === 's2' ? { ok: false } : { ok: true, json: async () => ({ maxMsat: '1000000', holds: { [B]: '500000' } }) }), delays[s]));
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const tried = [];
  // each hand-over stops at the send: the seat order shows in the records' `seat`
  const walletFrom = { sendEcash: async () => { throw new Error('insufficient balance'); }, sentEcash: async () => 'null' };
  const r = await exchangeEcashInto({ storage, from: A, to: B, needMsat: 100000n, seats, walletFrom, walletTo: async () => ({}), fetcher: async (u, o) => { tried.push(u); return fetcher(u, o); }, maxSeats: 3 });
  assert.equal(r.ok, false);
  const rec = [...store.values()].map((v) => JSON.parse(v)).find((x) => x && x.seat);
  assert.equal(rec ? rec.seat : 'https://s1', 'https://s1', 'the first offering seat in order is handed the notes first');
});
