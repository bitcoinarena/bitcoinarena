// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1483 (audit44, 683a02582), lens: ONE SEAT as the attacker. exchangeEcashInto now asks every seat's GET /exchange at
// once and waits for ALL of them (Promise.all) before it uses the first maxSeats offering seats. The old loop stopped asking once maxSeats seats
// offered, so a silent seat later in the list cost nothing. Now one silent (or deliberately stalling) seat anywhere in the list puts its whole
// offer timeout (8 s live) in front of every exchange, even when the first three seats offered at once - the opposite of "make it more efficient".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto } from '../src/ecash-transfer.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

test('a silent seat after three offering seats does not hold the exchange for its timeout', async () => {
  const seats = ['https://s1', 'https://s2', 'https://s3', 'https://s4'];
  const fetcher = (url, o = {}) => {
    if (o.method === 'POST') return Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, why: 'no' }), text: async () => 'no' });
    if (/s4/.test(url)) return new Promise((_, no) => o.signal.addEventListener('abort', () => no(new Error('timeout'))));   // the stalling seat
    return Promise.resolve({ ok: true, json: async () => ({ maxMsat: '1000000', holds: { [B]: '500000' } }) });
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const walletFrom = { sendEcash: async () => { throw new Error('stop here'); }, sentEcash: async () => 'null' };
  const t0 = Date.now();
  await exchangeEcashInto({ storage, from: A, to: B, needMsat: 100000n, seats, walletFrom, walletTo: async () => ({}), fetcher, offerTimeoutMs: 1500, maxSeats: 3 });
  const ms = Date.now() - t0;
  assert.ok(ms < 700, `the exchange waited ${ms} ms on the one silent seat although s1, s2, s3 offered at once`);
});
