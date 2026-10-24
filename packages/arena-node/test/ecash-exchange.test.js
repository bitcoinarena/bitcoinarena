// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN E-CASH EXCHANGE BETWEEN FEDERATIONS (kanban #614): the player's notes of one federation in, the seat's notes of the other out, the
// same amount; a retry with the same notes answered the same, never paid twice; nothing taken when the seat cannot pay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEcashExchange } from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const NOTES = 'fedimintA'.padEnd(40, 'x');

function seat({ holdsB = 500_000n, payFails = 0 } = {}) {
  const calls = [];
  const received = new Set();
  let fails = payFails, n = 0;
  const ports = {
    [A]: { ecashBalance: async () => 0n, ecashSend: async () => { throw new Error('no'); },
      ecashReceive: async (e) => { calls.push(['receive', e]); if (received.has(e)) return { state: 'AlreadyReceived', msat: 0n }; received.add(e); return { state: 'Success', msat: 100_000n }; } },
    [B]: { ecashReceive: async () => ({ state: 'Rejected', msat: 0n }), ecashBalance: async () => holdsB,
      ecashSend: async (m) => { calls.push(['send', m]); if (fails > 0) { fails--; throw new Error('the federation did not answer'); } holdsB -= m; return { ecash: `fedimintB-${++n}-${m}`, msat: m }; } },
  };
  const ex = createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
  return { ex, calls };
}

test('notes of one federation in, the same amount of the seat\'s notes of the other out', async () => {
  const { ex, calls } = seat();
  const r = await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.msat, '100000');
  assert.equal(r.federation, B);
  assert.deepEqual(calls.map((c) => c[0]), ['receive', 'send']);
});

test('asked again with the same notes: the same answer, nothing paid twice', async () => {
  const { ex, calls } = seat();
  const r1 = await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  const r2 = await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  assert.equal(r2.ok, true); assert.equal(r2.again, true); assert.equal(r2.ecash, r1.ecash);
  assert.equal(calls.filter((c) => c[0] === 'send').length, 1);
});

test('a seat that holds too little in the other federation takes nothing', async () => {
  const { ex, calls } = seat({ holdsB: 50_000n });
  const r = await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.why, /too little/);
  assert.equal(calls.length, 0, 'no notes taken');
});

test('a payout that failed is paid when asked again with the same notes', async () => {
  const { ex, calls } = seat({ payFails: 1 });
  const r1 = await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  assert.equal(r1.ok, false); assert.equal(r1.status, 503);
  const r2 = await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  assert.equal(r2.ok, true, r2.why); assert.equal(r2.msat, '100000');
  assert.equal(calls.filter((c) => c[0] === 'receive').length, 1, 'the notes were taken once');
});

test('limits: per exchange, and wrong input refused before anything moves', async () => {
  const { ex, calls } = seat();
  assert.equal((await ex.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '2000000' })).status, 409);
  assert.equal((await ex.exchange({ from: A, to: A, ecash: NOTES, amountMsat: '1000' })).status, 400);
  assert.equal((await ex.exchange({ from: 'xx', to: B, ecash: NOTES, amountMsat: '1000' })).status, 400);
  assert.equal(calls.length, 0);
});
