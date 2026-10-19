// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NOBODY WON: a loser's stake lock is forfeited back to its player at settlement, not at expiry (2026-10-03, "1 is
// fine") - only on this signer node's own record: settlement ACCEPTED, no winner's share, the lock not claimed, no entry
// still inside its window; a walk-away (FORFEIT) never.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Forfeit } from '../src/forfeit.js';

const lock = { outpoint: 'aa:0' };
const roundWith = (o = {}) => ({
  lockSettlement: () => ('settlement' in o ? o.settlement : { state: 'ACCEPTED' }),
  lockSettlementMoves: () => ('moves' in o ? o.moves : { claims: [], payouts: 7 }),
  lockSettlementShares: () => ('shares' in o ? o.shares : []),
  entriesOf: () => [],
});
const back = (round, outcome = 'FAILED') => new Forfeit(round, {}).nobodyWonReturn(new Uint8Array(32), new Uint8Array(32), lock, { outcome });

test('a FAILED run in a round that paid no winner gets its stake back at settlement', () => {
  assert.equal(back(roundWith()).ok, true);
  assert.equal(back(roundWith(), 'DELIVERED').ok, true);   // below the score: never at risk
});

test('never for a walk-away, a claimed lock, a paid winner, or before the settlement is ACCEPTED', () => {
  assert.match(back(roundWith(), 'FORFEIT').why, /walk-away/);
  assert.match(back(roundWith({ moves: { claims: ['aa:0'], payouts: 0 } })).why, /claimed/);
  assert.match(back(roundWith({ shares: [{ pubkey: new Uint8Array(32), msat: 1n }] })).why, /paid a winner/);
  assert.match(back(roundWith({ shares: null })).why, /paid a winner/);
  assert.match(back(roundWith({ settlement: { state: 'SUBMITTING' } })).why, /not ACCEPTED/);
  assert.match(back(roundWith({ settlement: null })).why, /not ACCEPTED/);
  assert.match(back(roundWith({ moves: null })).why, /no record/);
});
