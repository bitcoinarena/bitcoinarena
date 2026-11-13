// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute item 21 (#1637): "the seat can pay before it takes anything" counts as owed only TAKEN and SENDING rows.
// A RECEIVING row whose reissue WAS asked (receive_asked = 1) may already hold the player's notes - the federation reissued them and the
// answer was lost (timeout). It is not counted as owed: a new exchange passes the check, spends the seat's notes in `to`, and the first
// player's retry then finds AlreadyReceived (his notes are with the seat) but is held 503 for good - notes taken, nothing paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const NOTES1 = 'fedimintq'.padEnd(60, 'q');
const NOTES2 = 'fedimintr'.padEnd(60, 'r');

test('a44 refute 21-1: an asked RECEIVING row whose notes reached the seat is not counted as owed - another exchange spends its payout', async () => {
  let holdsB = 150_000n; let loseAnswerOf = NOTES1;
  const received = new Map(), sent = new Map();
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => {
        if (received.has(e)) return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: received.get(e) };
        received.set(e, 100_000n);
        // the federation reissued the notes, the answer was lost on the way back (tool timeout)
        if (loseAnswerOf === e) { loseAnswerOf = null; throw new Error('arena-stake-lock ecash-receive: timed out'); }
        return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n };   // the notes' own amount (kanban #1936)
      } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m, { key }) => {
        if (sent.has(key)) return sent.get(key);
        if (m > holdsB) throw new Error(`insufficient balance: ${holdsB} msat for ${m}`);
        holdsB -= m; const out = { ecash: `fedimintb${key.slice(0, 8)}`, msat: m }; sent.set(key, out); return out;
      },
      ecashSent: async (key) => (sent.has(key) ? { found: true, ...sent.get(key) } : { found: false }) },
  };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
  const a1 = await x.exchange({ from: A, to: B, ecash: NOTES1, amountMsat: '100000' });
  assert.equal(a1.status, 503);
  assert.ok(received.has(NOTES1), 'player 1\'s notes are with the seat now');
  // player 2 comes in while player 1's answer is lost: 150 sat held, but 100 of it is owed to player 1
  const b = await x.exchange({ from: A, to: B, ecash: NOTES2, amountMsat: '100000' });
  // player 1 asks again
  const a2 = await x.exchange({ from: A, to: B, ecash: NOTES1, amountMsat: '100000' });
  const row = x.stateOf(ex.noteKey(NOTES1));
  assert.ok(a2.ok,
    `player 1's notes are taken (row ${row.state}, answer ${a2.status} "${a2.why}") and not paid: player 2's new exchange was let through (${b.ok ? 'paid' : b.status}) with the seat's notes owed to player 1; holds ${holdsB} msat`);
});
