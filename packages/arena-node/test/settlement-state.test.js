// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 2026.0.3 STEP 6 - A ROUND THAT TAKES ANY FEDERATION READS AS ONE SETTLEMENT (kanban #348). It keeps one row per federation and
// none in lock_settlements, so the forfeit, the winnings plan, the standing and the sweeps ask settlementState: ACCEPTED once every
// federation's transaction is. Its moves are kept once over all its federations (keepFederationMoves), as keepMoves keeps one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { LockSettlement, FEDERATIONS_TXID } from '../src/settlement.js';
import { stateOf } from '../src/settlement-state.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x5f);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const row = (federation, state) => ({ roundId: RID, federation, txid: federation.slice(0, 8), message: b32(1), signature: new Uint8Array(64), state, why: state });

test('ACCEPTED once every federation is; SUBMITTING while one is not; null with none; a one-federation round reads its row', () => {
  const round = new Round(openStore(':memory:'));
  assert.equal(stateOf(round, RID), null);
  round.putFedLockSettlement(row(A, 'ACCEPTED'));
  round.putFedLockSettlement(row(B, 'SUBMITTING'));
  assert.equal(stateOf(round, RID), 'SUBMITTING');
  round.putFedLockSettlement(row(B, 'ACCEPTED'));
  assert.equal(stateOf(round, RID), 'ACCEPTED');
  // a store without settlementState (a test's stub) answers from its one row
  assert.equal(stateOf({ lockSettlement: () => ({ state: 'ACCEPTED' }) }, RID), 'ACCEPTED');
  assert.equal(stateOf({ lockSettlement: () => null }, RID), null);
});

test('the moves of every federation\'s transaction are kept once, under "federations", with the plan\'s winners\' shares', () => {
  const round = new Round(openStore(':memory:'));
  const ls = new LockSettlement(round, {});
  const claim = (n) => ({ outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) } });
  ls.keepFederationMoves(RID, { plan: { stakeShares: [{ pubkey: b32(1), msat: 7n }] },
    split: { settlements: [{ claims: [claim(3)], payouts: [1, 2] }, { claims: [claim(4), claim(5)], payouts: [1, 2, 3] }] } });
  const moves = round.lockSettlementMoves(RID);
  assert.equal(moves.txid, FEDERATIONS_TXID);
  assert.deepEqual(moves.claims, [3, 4, 5].map((n) => `${Buffer.from(b32(0x40 + n)).toString('hex')}:${n}`));
  assert.equal(moves.payouts, 5);
  assert.deepEqual(round.lockSettlementShares(RID).map((x) => x.msat), [7n]);
});
