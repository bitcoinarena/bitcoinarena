// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ENTRY FINALITY IS MONOTONIC WHERE MONEY MOVES ON IT (kanban #1173, the 2026-11-06 state-machine audit). Before: the /objection door took the arrival
// time, replayed the bundle, and only then stored the objection with that arrival; resultFinality was recomputed on every read. An objection arriving
// just before final_after was invisible while its replay ran - the seat computed FINAL, signed FINAL, released P, acked - and then the entry read
// SUSPENDED: non-monotonic after irreversible acts. And a seat that saw the objection late held FINAL on the lost first run, so the committee's re-run
// forfeit of the qualifier's stake read as offence (b) there. Now: a pending row at arrival, before the replay (withPendingObjection); finalityStep
// holds the entry SUSPENDED while one that arrived before final_after is checked, keeps FINAL once reached, and an objection reaching a FINAL entry is
// dated past its final_after (evidence, never a suspension); row (b) reads an agreed re-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import * as finality from '../src/finality.js';
import * as server from '../src/server.js';
import * as forfeit from '../src/forfeit.js';
import { FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x73), EID = b32(0x74), E2 = b32(0x75);
const RUN = 'c1'.repeat(32);
const FINAL_AFTER = 1_000_000n;
const CONTRACT = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 2 });

function store(nowMs) {
  const round = new Round(openStore(':memory:'));
  let now = nowMs;
  round.now = () => now;
  return { round, at: (ms) => { now = ms; } };
}
const finalAt = () => ({ state: FINAL, runId: RUN, finalAfterMs: FINAL_AFTER, published: true, why: 'signed FINAL by 5 of 7 seats' });
const signableAt = () => ({ state: PROVISIONALLY_FINAL, runId: RUN, finalAfterMs: FINAL_AFTER, published: true, signable: { runId: b32(0xc1), finalAfterMs: FINAL_AFTER }, why: 'the window closed' });
const suspendedBy = (filedAtMs) => ({ state: SUSPENDED, runId: RUN, finalAfterMs: FINAL_AFTER, filedAtMs, objection: 'holds', why: `a valid objection reached this seat at ${filedAtMs}` });

test('#1173 an objection being checked, arrived before final_after, holds the entry SUSPENDED: no FINAL, no signable - then the check answers', async () => {
  const { finalityStep } = finality;
  assert.equal(typeof finalityStep, 'function', 'one transition function over the computed finality');
  assert.equal(typeof server.withPendingObjection, 'function', 'the door writes the objection\'s arrival before its replay');
  const { round, at } = store(Number(FINAL_AFTER) - 2000);
  const arrived = Number(FINAL_AFTER) - 2000;
  const seen = [];
  // THE DOOR'S ORDER: the arrival kept, then the replay; while it runs the seat's clock passes final_after and the evidence reads FINAL / signable
  await server.withPendingObjection(round, RID, EID, arrived, async () => {
    at(Number(FINAL_AFTER) + 100);
    for (const computed of [finalAt(), signableAt()]) {
      const old = computed;                                   // the old source: resultFinality was the computed finality as it is
      const now = finalityStep(round, RID, EID, computed);
      seen.push({ evidence: computed.state, old: `${old.state}${old.signable ? ' signable' : ''}`, now: `${now.state}${now.signable ? ' signable' : ''}${now.pendingObjection ? ' (objection being checked)' : ''}` });
    }
  });
  for (const x of seen) console.log(`#1173 objection arrived ${arrived} < final_after ${FINAL_AFTER}, replay running at ${Number(FINAL_AFTER) + 100}: evidence ${x.evidence} - old ${x.old}, now ${x.now}`);
  assert.deepEqual(seen.map((x) => x.now), ['SUSPENDED (objection being checked)', 'SUSPENDED (objection being checked)']);
  assert.equal(finalityStep(round, RID, EID, finalAt()).state, FINAL, 'its check answered (refused): the pending row is gone');
  // a pending row that arrived after final_after holds nothing (a late objection suspends nothing)
  const late = store(Number(FINAL_AFTER) + 500).round;
  late.putPendingObjection(RID, EID, Number(FINAL_AFTER) + 10);
  assert.equal(finalityStep(late, RID, EID, signableAt()).signable !== undefined, true);
  // and a check that never answered (a process cut short) frees the entry after PENDING_OBJECTION_MS
  const stale = store(Number(FINAL_AFTER) + finality.PENDING_OBJECTION_MS + 10).round;
  stale.putPendingObjection(RID, EID, Number(FINAL_AFTER) - 5);
  assert.equal(finalityStep(stale, RID, EID, finalAt()).state, FINAL);
  assert.equal(stale.clearPendingObjections(), 1, 'a restart drops the checks it cut short');
});

test('#1173 FINAL is kept once reached: an objection stored afterwards, dated before final_after, does not turn it back', () => {
  const { finalityStep } = finality;
  const { round } = store(Number(FINAL_AFTER) + 100);
  const first = finalityStep(round, RID, EID, finalAt());
  assert.equal(first.state, FINAL);
  assert.ok(round.entryFinal(RID, EID), 'FINAL kept');
  // later the evidence reads SUSPENDED (an objection stored with an arrival before final_after)
  const evidence = suspendedBy(Number(FINAL_AFTER) - 50);
  const after = finalityStep(round, RID, EID, evidence);
  console.log(`#1173 FINAL reached at ${Number(FINAL_AFTER) + 100}, then an objection dated ${Number(FINAL_AFTER) - 50}: old ${evidence.state}, now ${after.state} (lateObjection ${after.lateObjection})`);
  assert.equal(after.state, FINAL);
  assert.equal(after.runId, RUN);
  assert.equal(after.lateObjection, true);
  assert.equal(after.signable, undefined);
  // a look ahead (a caller's `now` past this seat's clock) keeps nothing
  const { round: r2 } = store(Number(FINAL_AFTER));
  finalityStep(r2, RID, EID, finalAt(), { now: Number(FINAL_AFTER) + 9999 });
  assert.equal(r2.entryFinal(RID, EID), null);
});

test('#1173 the intake: an objection that reaches an entry FINAL here is dated past its final_after - evidence, never a suspension', () => {
  const { round } = store(Number(FINAL_AFTER) - 1000);
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: CONTRACT } : null);
  const stored = [];
  round.object = (rid, eid, block, bundle, seenMs) => { stored.push(seenMs); return true; };
  round.putEntryFinal({ roundId: RID, entryId: EID, runId: RUN, finalAfterMs: FINAL_AFTER, atMs: Number(FINAL_AFTER) - 3000 });
  const arrived = Number(FINAL_AFTER) - 1000;
  const got = server.objectionIntake(round, RID, EID, null, new Uint8Array([1]), arrived);
  console.log(`#1173 an entry FINAL here (kept), objection arrived ${arrived}: stored as of ${stored[0]} (final_after ${FINAL_AFTER}) - ${got.status} ${got.text}`);
  assert.equal(got.status, 201);
  assert.ok(BigInt(stored[0]) >= FINAL_AFTER, 'stored as in time: it would suspend an entry this seat already acted on');
});

test('#1173 row (b): the committee\'s agreed re-run by which the entry qualifies allows its forfeit back, at a seat that saw the objection late', () => {
  const round = { get: () => ({ contract: CONTRACT }), entriesOf: () => [{ entryId: EID }, { entryId: E2 }], entryVoid: () => false };
  // this seat saw the objection late: FINAL on the first run, where EID lost and E2 won
  const finalityOf = () => ({ state: FINAL });
  const settledOf = (r, rid, eid) => (toHex(eid) === toHex(EID) ? { outcome: FAILED, score: 0 } : { outcome: DELIVERED, score: 5 });
  const rerunOf = (r, rid, eid) => (toHex(eid) === toHex(EID) ? { ok: true, runId: 'd2'.repeat(32), result: { outcome: DELIVERED, score: 5 } } : { ok: false });
  const got = forfeit.lostForfeitAllowed(round, RID, EID, { finalityOf, settledOf, rerunOf });
  const without = forfeit.lostForfeitAllowed(round, RID, EID, { finalityOf, settledOf, rerunOf: () => ({ ok: false }) });
  console.log(`#1173 row (b), late-objection seat: with the agreed re-run allowed=${got.allowed}; without one allowed=${without.allowed}`);
  assert.equal(got.allowed, true, 'an honest seat forfeiting a qualifier\'s stake by the agreed re-run would be judged an offence');
  assert.equal(without.allowed, false);
  // the default reads the store's re-runs: none held, none agreed
  assert.deepEqual(finality.agreedRerunOf(new Round(openStore(':memory:')), RID, EID), { ok: false });
});

// KANBAN #1225 (audit 2 #1204 SETTLEMENT-3): checks of one entry run one at a time, and the pending row held the entry for 120 s only - a valid
// objection queued behind enough junk (or on a loaded seat) waited past that, the seat signed FINAL and the objection was re-dated late. Now a
// check still queued or running in this process holds the entry whatever the row's age; with none in flight the 120 s rule stands.
test('#1225 an objection whose check is still queued past PENDING_OBJECTION_MS keeps the entry SUSPENDED; once it answered, the age rule again', () => {
  const { finalityStep } = finality;
  const s = store(Number(FINAL_AFTER) + finality.PENDING_OBJECTION_MS + 60000);   // three minutes on: the row is "old"
  s.round.putPendingObjection(RID, EID, Number(FINAL_AFTER) - 5);
  s.round.objectionChecks = new Map([[toHex(EID), 3]]);                          // three checks of that entry still queued here
  const held = finalityStep(s.round, RID, EID, finalAt());
  assert.equal(held.state, SUSPENDED, 'a queued check of an objection in time was dropped for its age');
  assert.equal(held.pendingObjection, true);
  s.round.objectionChecks.delete(toHex(EID));                                     // the queue drained (the check never removed its row)
  assert.equal(finalityStep(s.round, RID, EID, finalAt()).state, FINAL, 'with no check in flight the 120 s rule frees it');
});
