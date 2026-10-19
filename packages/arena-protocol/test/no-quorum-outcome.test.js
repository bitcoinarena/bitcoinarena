// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NO-QUORUM OUTCOME - payout.js noQuorumOutcome on its own (kanban #146, fifth surface; plan comment 194, Go
// 2026-10-05). It decides the card's "no quorum VOID" and "proven equivocation FORFEIT" paths, and that a FINAL result is
// never voided; finality.js asks it at the in-time quorum, on a provisional run and on a suspended one. Until now protocol's
// own suite never called it (payout.js lines 329-369 uncovered). No defect was read from the source before this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noQuorumOutcome, FORFEIT, VOID } from '../src/payout.js';
import { FINAL, PROVISIONALLY_FINAL, SUSPENDED } from '../src/objection.js';

const FINAL_WHY = 'that result is already FINAL, and a later failure does not erase it: VOID is reachable only from PROVISIONAL';
const voided = (s, n) => `no quorum at ${s} of ${n}, and nothing shows the player caused it: the fault is the operator side and the stake goes back`;

test('a FINAL result is never voided, whatever the count or the proof', () => {
  assert.equal(FINAL, 'FINAL');
  for (const o of [{ signatures: 0, needed: 5 }, { signatures: 4, needed: 5, equivocationProven: true }, { signatures: 5, needed: 5 }])
    assert.deepEqual(noQuorumOutcome({ ...o, state: FINAL }), { outcome: null, why: FINAL_WHY });
});

test('at or above the threshold the committee agreed: no outcome is imposed, from any state short of FINAL', () => {
  for (const state of [null, undefined, PROVISIONALLY_FINAL, SUSPENDED]) {
    assert.deepEqual(noQuorumOutcome({ signatures: 5, needed: 5, state }), { outcome: null, why: 'the committee agreed: 5 of 5' });
    assert.deepEqual(noQuorumOutcome({ signatures: 7, needed: 5, equivocationProven: true, state }), { outcome: null, why: 'the committee agreed: 7 of 5' });
  }
});

test('below the threshold: a checked proof of two chains forfeits; anything else voids and the stake goes back', () => {
  assert.equal(FORFEIT, 'FORFEIT');
  assert.equal(VOID, 'VOID');
  for (const state of [null, PROVISIONALLY_FINAL, SUSPENDED]) {
    assert.deepEqual(noQuorumOutcome({ signatures: 4, needed: 5, equivocationProven: true, state }),
      { outcome: FORFEIT, why: 'no quorum at 4 of 5, and the player signed two chains: 13B forfeits the entry' });
    assert.deepEqual(noQuorumOutcome({ signatures: 4, needed: 5, equivocationProven: false, state }), { outcome: VOID, why: voided(4, 5) });
  }
  assert.deepEqual(noQuorumOutcome({ signatures: 0, needed: 5 }), { outcome: VOID, why: voided(0, 5) });
  // only `true` is a checked proof: a truthy value that is not is no proof, and the stake goes back
  for (const equivocationProven of ['yes', 1, {}, [], 'true'])
    assert.deepEqual(noQuorumOutcome({ signatures: 4, needed: 5, equivocationProven }), { outcome: VOID, why: voided(4, 5) },
      `${JSON.stringify(equivocationProven)} forfeited a stake`);
});

test('a 2-of-2 committee: 1 of 2 voids, 2 of 2 agreed', () => {
  assert.deepEqual(noQuorumOutcome({ signatures: 1, needed: 2 }), { outcome: VOID, why: voided(1, 2) });
  assert.deepEqual(noQuorumOutcome({ signatures: 2, needed: 2 }), { outcome: null, why: 'the committee agreed: 2 of 2' });
});

test('refused by name: a signature count that is not a count, a threshold that is not positive', () => {
  for (const signatures of [-1, 1.5, '3', undefined])
    assert.throws(() => noQuorumOutcome({ signatures, needed: 5 }), { message: 'signatures is a count of committee members, and cannot be negative' });
  for (const needed of [0, -1, 1.5, undefined, '5'])
    assert.throws(() => noQuorumOutcome({ signatures: 3, needed }), { message: 'the threshold is a positive count of committee members' });
});
