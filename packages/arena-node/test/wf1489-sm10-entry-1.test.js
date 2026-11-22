// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, state-machine audit round 10, area entry, finding 1.
//
// AN OUTAGE ENTRY_VOID, THEN THE PLAYER'S SECOND FIRST MARK (§13B; ruled 2026-09-12): "the Void stays as history and the entry
// is decided ... like any two first marks - FORFEIT after the window" (verify.js #noQuorum writes no_quorum FORFEIT). The
// forfeit door reads it that way and signs no refund. The settlement does not: entriesOnRecord tests entryVoid BEFORE the
// stored no-quorum record, so the same store lists the entry ENTRY_VOID - a refund that neither feeds nor draws from the pool,
// its stake and fee lock left unclaimed (§23.2) - while a seat of the same round that holds the pair but recorded no Void lists
// it FORFEIT (claimed like a walk-away, ruling 2026-10-04 (b)). One entry, three answers: the forfeit says FORFEIT, this seat's
// settlement says ENTRY_VOID, the other seat's says FORFEIT - the two seats build two plans, and the lock is neither returned
// nor claimed here: it goes back to the equivocating player at its expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { LOSER } from './window-fixture.js';
import { LockSettlement } from '../src/settlement.js';
import { Forfeit } from '../src/forfeit.js';
import { decodeCheckpoint, encodeCheckpoint, checkpointId, joinSigned, splitSigned } from '../../arena-protocol/src/checkpoint.js';
import { sha256 } from '../../arena-protocol/src/hash.js';

test('an outage ENTRY_VOID later decided FORFEIT on two first marks is listed FORFEIT by the settlement, as the forfeit door and the other seat read it', async () => {
  const w = await lockRound();
  try {
    const played = await lockAndPlay(w, LOSER);
    const first = played.late[1];                                         // the player's on-time first mark, as both seats hold it
    const c = decodeCheckpoint(splitSigned(first).body);
    const other = { ...c, stateHash: sha256(Uint8Array.of(7, ...c.stateHash)) };
    const second = joinSigned(encodeCheckpoint(other), ed25519.sign(checkpointId(other), played.session));
    const why = 'the player signed two first marks for this entry (§13B): FORFEIT';
    // SEAT A: it recorded the outage Void first (§16), then the pair reached it and §13C decided FORFEIT - the Void stays as history
    w.a.round.putEntryVoid({ entryId: played.eid, roundId: w.rid, firstMark: first, evidenceKind: 'mark', why: 'outage (§16)' });
    assert.equal(w.a.round.putFirstMarkPair({ a: first, b: second }), true, 'the pair was not kept at seat A');
    w.a.round.putNoQuorum({ entryId: played.eid, roundId: w.rid, outcome: 'FORFEIT', why });
    // SEAT B: the same pair and the same §13C FORFEIT, no outage Void of its own
    assert.equal(w.b.round.putFirstMarkPair({ a: first, b: second }), true, 'the pair was not kept at seat B');
    w.b.round.putNoQuorum({ entryId: played.eid, roundId: w.rid, outcome: 'FORFEIT', why });

    const forfeitA = await new Forfeit(w.a.round, {}).message(w.rid, played.eid);
    const onA = new LockSettlement(w.a.round, {}).entriesOnRecord(w.rid, null);
    const onB = new LockSettlement(w.b.round, {}).entriesOnRecord(w.rid, null);
    const outcomes = (r) => (r.ok ? r.entries.map((e) => e.outcome) : r.why);
    console.log('  FACTS:', JSON.stringify({ forfeitA: forfeitA.why, seatA: outcomes(onA), seatB: outcomes(onB) }));

    assert.equal(forfeitA.ok, false);
    assert.match(forfeitA.why, /two first marks .*FORFEIT, never the outage refund/, 'the forfeit door reads the entry FORFEIT');
    assert.deepEqual(outcomes(onB), ['FORFEIT'], 'seat B lists the equivocator FORFEIT');
    assert.deepEqual(outcomes(onA), outcomes(onB), 'two seats of one round list one entry differently: their settlements can never agree');
    assert.deepEqual(outcomes(onA), ['FORFEIT'], 'seat A lists as an ENTRY_VOID refund an entry its own forfeit door holds FORFEIT');
  } finally { await w.close(); }
});
