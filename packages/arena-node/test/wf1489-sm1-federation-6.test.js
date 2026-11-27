// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation, 2026-11-27): AN ASKED RECEIVING ROW WHOSE NOTES THE PLAYER TOOK BACK IS OWED FOREVER.
// ecash-exchange.js counts every RECEIVING row with receive_asked = 1 as owed out of the seat's notes in `to` at its want_msat (#2143),
// with no end: owedRows has no time bound, and nothing but the player's own retry ever moves such a row on. The page gives a handed
// exchange up after ECASH_HANDED_RECLAIM_MS (10 min) of a silent seat (a 503 is silent) and takes its notes back into its own wallet
// (ecash-transfer.js advanceEcashExchange -> reclaiming -> receive Success -> record removed) - and never asks the seat again.
// Path: the seat's receive run fails before anything reaches the federation (its client directory busy with a settle, the guardians
// not reachable) -> 503 "ask again" -> the seat stays silent for 10 min -> the page reclaims its notes (Success: they were never
// reissued) -> the seat row RECEIVING / receive_asked 1 is never asked again. Each such row pins want_msat of the seat's notes in `to`
// for good: honest exchanges into `to` are refused 409 "holds 0 sat free" days later, while the seat holds the sats and owes nobody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEcashExchange } from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const P1 = 'fedimintA'.padEnd(40, 'a');   // decodes (kanban #2384)
const P2 = 'fedimintC'.padEnd(40, 'c');

test('wf1489-sm1-federation-6: notes the player took back after a failed receive do not pin the seat\'s balance forever', async () => {
  const db = new DatabaseSync(':memory:');
  let nowMs = 1_800_000_000_000;
  const spent = new Set(); let down = true; let holdsB = 100_000n; let n = 0;
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => {
        if (down) throw new Error('arena-stake-lock ecash-receive: the client directory is locked by another process');   // nothing reached a guardian
        if (spent.has(e)) return { state: 'Rejected', msat: 0n };
        spent.add(e); return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n };
      } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m) => { holdsB -= m; return { ecash: `fedimintb${++n}`.padEnd(40, 'b'), msat: m }; },
      ecashSent: async () => ({ found: false }) },
  };
  const x = createEcashExchange({ db, portOf: async (f) => ports[f] || null, now: () => nowMs });
  // player 1: the seat's receive run fails, 503 - the page asks again for 10 minutes, the seat is still failing
  const first = await x.exchange({ from: A, to: B, ecash: P1, amountMsat: '100000' });
  assert.equal(first.status, 503);
  nowMs += 11 * 60_000;
  // the page gives the exchange up and takes its notes back into its own wallet: they are spent now, by the player
  spent.add(P1);
  down = false;
  const row = db.prepare('SELECT state, receive_asked FROM ecash_exchanges').get();
  // two days later player 2 exchanges 100 sat; the seat holds 100 sat in B and owes nobody anything
  nowMs += 2 * 24 * 3_600_000;
  const second = await x.exchange({ from: A, to: B, ecash: P2, amountMsat: '100000' });
  console.log('  MEASURED:', JSON.stringify({ row, seatHoldsB: String(holdsB), second: { ok: second.ok, status: second.status, why: second.why } }));
  assert.ok(second.ok, `the seat holds ${holdsB} msat in B and owes nothing, yet refuses: ${second.status} ${second.why}`);
});
