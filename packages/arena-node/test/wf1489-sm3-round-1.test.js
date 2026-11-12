// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit (round 3, area round): TWO OBJECTIONS FOR ONE ENTRY THAT REACH THE SEAT IN THE SAME MILLISECOND SHARE ONE
// pending_objections ROW (primary key round, entry, arrived_ms). The /objection door stamps arrivedMs = round.now() and runs each check inside
// withPendingObjection; checks of one entry run one at a time (verify.js checkObjection). The first check to answer - a junk bundle refused at its
// cheap step - drops the row by (round, entry, arrived_ms), which is also the row of the valid objection still queued behind it. From then on
// finalityStep sees no pending objection (the in-flight count holds a row of any age, never a row that is gone), the seat computes FINAL past
// final_after, keeps it in entry_finals, signs FINAL / releases P / acks - and when the valid objection's check answers, objectionIntake re-dates it
// to final_after: late, suspends nothing. The invariant #1173/#1225 promise: a check of an objection that arrived before final_after, still queued
// or running here, holds the entry SUSPENDED until it answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import * as finality from '../src/finality.js';
import * as server from '../src/server.js';
import { FINAL, SUSPENDED } from '../../arena-protocol/src/objection.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x51), EID = b32(0x52);
const RUN = 'd1'.repeat(32);
const FINAL_AFTER = 2_000_000n;
const finalAt = () => ({ state: FINAL, runId: RUN, finalAfterMs: FINAL_AFTER, published: true, why: 'signed FINAL by 5 of 7 seats' });

test('wf1489-sm3-round-1: a junk objection refused first drops the pending row of a valid one that arrived in the same ms - the seat goes FINAL while the valid check is still queued', async () => {
  const round = new Round(openStore(':memory:'));
  let now = Number(FINAL_AFTER) - 3000;
  round.now = () => now;
  const arrived = now;                                  // both bodies read in one tick: the door stamps the same round.now()
  // checkObjection's own in-flight count (verify.js): +1 when a check is queued, -1 when it answered
  const live = round.objectionChecks = new Map();
  const queue = (k) => live.set(k, (live.get(k) || 0) + 1);
  const done = (k) => { const n = (live.get(k) || 1) - 1; if (n > 0) live.set(k, n); else live.delete(k); };
  const key = toHex(EID);

  let releaseValid;
  const validTurn = new Promise((r) => { releaseValid = r; });
  const seen = [];
  // THE VALID OBJECTION (queued second: its check waits for the junk one's turn, FIFO per entry)
  queue(key);
  const valid = server.withPendingObjection(round, RID, EID, arrived, async () => {
    await validTurn;
    done(key);
    return { holds: true };
  });
  // THE JUNK ONE, same arrival ms, refused at its cheap step
  queue(key);
  await server.withPendingObjection(round, RID, EID, arrived, async () => { done(key); return { holds: false, step: 'receipts', why: 'junk' }; });

  // the valid check is still queued here; the seat's clock passes final_after and the evidence alone reads FINAL
  now = Number(FINAL_AFTER) + 200;
  const mid = finality.finalityStep(round, RID, EID, finalAt());
  seen.push({ checksInFlight: live.get(key) || 0, pendingRow: round.pendingObjectionAt(RID, EID, 0), state: mid.state, keptFinal: !!round.entryFinal(RID, EID) });
  releaseValid();
  await valid;
  console.log(`wf1489-sm3-round-1 two objections arrived at ${arrived} (final_after ${FINAL_AFTER}); junk answered first; at ${now}: `
    + `checks in flight ${seen[0].checksInFlight}, pending row ${seen[0].pendingRow}, entry ${seen[0].state}, FINAL kept ${seen[0].keptFinal}`);
  assert.equal(seen[0].checksInFlight, 1, 'the valid check is still queued');
  assert.equal(seen[0].state, SUSPENDED, 'a check of an objection that arrived before final_after is still queued here, and the seat already reads FINAL (and keeps it)');
  assert.equal(seen[0].keptFinal, false, 'FINAL kept while a valid in-time objection was still being checked: its intake will re-date it late');
});
