// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2 federation-1: the e-cash exchange checks "the seat can pay before it takes anything" (and the hour's limit) only
// when the row is NEW. A row left in RECEIVING by a reissue that did not answer (the federation never took the notes) is retried
// later with no check at all: meanwhile another exchange spent the seat's notes in `to`, the retry reissues the player's notes into the
// seat, and the payout then fails - the exchange sits in SENDING, the player's notes taken, nothing paid, until an operator refills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const NOTES1 = 'fedimintq'.padEnd(60, 'q');
const NOTES2 = 'fedimintr'.padEnd(60, 'r');

function seat({ holdsB = 150_000n, failFirstReceiveOf = null } = {}) {
  const received = new Map(), log = new Map();
  let failOnce = failFirstReceiveOf;
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => {
        // the guardians did not answer: the tool gave up BEFORE the federation reissued anything
        if (failOnce && e === failOnce) { failOnce = null; throw new Error('arena-stake-lock ecash-receive: no guardian answered'); }
        if (received.has(e)) return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: received.get(e) };
        received.set(e, 100_000n);
        return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n };   // the notes' own amount (kanban #1936)
      } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m, { key = null } = {}) => {
        if (key && log.has(key)) return { ...log.get(key), again: true };
        if (m > holdsB) throw new Error(`insufficient balance: ${holdsB} msat for ${m}`);
        holdsB -= m; const out = { ecash: `fedimintb${key.slice(0, 8)}`, msat: m };
        log.set(key, out); return out;
      },
      ecashSent: async (key) => (log.has(key) ? { found: true, ...log.get(key) } : { found: false }) },
  };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
  return { x, received, holdsB: () => holdsB };
}

test('wf1489 sm2 federation-1: a retried exchange takes the player\'s notes although the seat can no longer pay them', async () => {
  const s = seat({ holdsB: 150_000n, failFirstReceiveOf: NOTES1 });
  // player 1: the seat holds 150 sat in B, enough; the row is written, the reissue does not answer - nothing reissued
  const a1 = await s.x.exchange({ from: A, to: B, ecash: NOTES1, amountMsat: '100000' });
  assert.equal(a1.ok, false); assert.equal(a1.status, 503);
  assert.equal(s.received.has(NOTES1), false, 'the federation took nothing of player 1 yet');
  // player 2: a new exchange. Kanban #2143 (audit44 refute 21): player 1's row ASKED its reissue, and the seat cannot tell "the guardians
  // never took it" from "they took it and the answer was lost" - so its 100 sat count as owed, and player 2 (150 - 100 = 50 free) is
  // refused 409 before anything of his is taken; had player 2 been paid, a lost answer left player 1 with notes taken and nothing paid
  const b = await s.x.exchange({ from: A, to: B, ecash: NOTES2, amountMsat: '100000' });
  assert.equal(b.ok, false); assert.equal(b.status, 409, b.why);
  assert.equal(s.received.has(NOTES2), false, 'nothing of player 2 was taken');
  assert.equal(s.holdsB(), 150_000n);
  // player 1 asks again with the same notes (as the page does after a 503)
  const a2 = await s.x.exchange({ from: A, to: B, ecash: NOTES1, amountMsat: '100000' });
  const row = s.x.stateOf(ex.noteKey(NOTES1));
  // THE INVARIANT: the seat takes a player's notes only when it can pay them - either it pays, or the notes stay with the player
  const taken = s.received.has(NOTES1);
  assert.ok(a2.ok, `player 1 is paid on his retry (${a2.status} "${a2.why}")`);
  assert.ok(a2.ok || !taken,
    `player 1's notes were reissued into the seat (row ${row && row.state}, answer ${a2.status} "${a2.why}") while the seat holds ${s.holdsB()} msat of the 100000 it owes: taken, nothing paid`);
});
