// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation): an e-cash exchange whose reissue was ASKED (receive_asked = 1, the player's notes
// reissued into the seat's client) but whose answer was lost (tool timeout / seat stopped) stays RECEIVING. If the `from` federation is
// listed as liquidating before the retry, the halt check refuses every retry for good (#1272 let TAKEN/SENDING through, not an asked
// RECEIVING): the seat keeps the player's notes, the player is never paid, and his notes are already spent at the federation, so the
// arbitration set's claim cannot pay them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const NOTES = 'fedimintA'.padEnd(40, 'a')  // kanban #2384, #2436: notes that decode;

test('wf1489-sm1-federation-1: a reissue asked before the halt is finished after it, never kept unpaid', async () => {
  const db = new DatabaseSync(':memory:');
  const received = new Map(); let lost = 1; let holdsB = 500_000n; let n = 0;
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => {
        if (received.has(e)) return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: received.get(e) };
        received.set(e, 100_000n);
        if (lost-- > 0) throw new Error('arena-stake-lock ecash-receive timed out');
        return { state: 'Success', msat: 100_000n }; } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m) => { holdsB -= m; return { ecash: `fedimintb-${++n}`, msat: m }; },
      ecashSent: async () => ({ found: false }) },
  };
  const listed = new Set();
  const x = ex.createEcashExchange({ db, portOf: async (f) => ports[f] || null, halted: (f) => (listed.has(f) ? { height: 1000 } : null) });
  const first = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  assert.equal(first.ok, false); assert.equal(first.status, 503, 'the receive answer was lost');
  const row = db.prepare('SELECT state, receive_asked FROM ecash_exchanges').get();
  // federation A is listed as liquidating now (a halt proof, a record HALTED) - the player asks again with the same e-cash
  listed.add(A);
  const again = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  const after = db.prepare('SELECT state FROM ecash_exchanges').get();
  console.log('  MEASURED:', JSON.stringify({ rowAfterFirst: row, notesHeldBySeat: received.size, retry: { ok: again.ok, status: again.status, why: again.why }, stateAfter: after.state, paidOut: String(500_000n - holdsB) }));
  assert.equal(received.size, 1, 'the player\'s notes are in the seat\'s client');
  assert.ok(again.ok || after.state !== 'receiving',
    `the seat holds the player's reissued notes and refuses to finish the exchange forever: ${again.status} ${again.why}`);
  assert.equal(500_000n - holdsB, 100_000n, 'the player was paid for the notes the seat took');
});

test('wf1489-sm1-federation-1 (kanban #1579): an asked reissue that never reached the federation is not taken fresh after the halt', async () => {
  const db = new DatabaseSync(':memory:');
  let fail = 1; let holdsB = 500_000n; let receives = 0;
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async () => { if (fail-- > 0) throw new Error('arena-stake-lock ecash-receive timed out'); receives++; return { state: 'Success', msat: 100_000n }; } },
    [B]: { ecashBalance: async () => holdsB, ecashSend: async (m) => { holdsB -= m; return { ecash: 'fedimintb-1', msat: m }; }, ecashSent: async () => ({ found: false }) },
  };
  const listed = new Set();
  const x = ex.createEcashExchange({ db, portOf: async (f) => ports[f] || null, halted: (f) => (listed.has(f) ? { height: 1000 } : null) });
  assert.equal((await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' })).status, 503);
  listed.add(A);
  const again = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  const after = db.prepare('SELECT state FROM ecash_exchanges').get();
  assert.deepEqual([again.ok, again.status, after.state, String(500_000n - holdsB)], [false, 409, 'refused', '0']);
  // a new exchange out of the halted federation is still refused before anything is asked
  const fresh = await x.exchange({ from: A, to: B, ecash: 'fedimintC'.padEnd(40, 'b'), amountMsat: '100000' });
  assert.deepEqual([fresh.status, receives], [409, 1]);
});
