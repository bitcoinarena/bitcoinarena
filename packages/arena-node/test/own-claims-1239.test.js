// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1239 (audit 3 #1210 FIXES-8): the #1183 guard "a lock this round's own settlement claims is no refund" read only the round row,
// and a round that takes any federation has none - so once a refused federation made the round suspect, the losers a landed federation was
// paid by were written to gone_stakes as refunded, and the other federation built on a table the first was not paid under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownClaimsOf } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

const RID = new Uint8Array(32).fill(0x5e);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const bytes = new Uint8Array(4).fill(1);
const fedRow = (round, federation, txid, state) => round.putFedLockSettlement({ roundId: RID, federation, txid, message: bytes, signature: bytes, state, why: '' });
const moves = (round, federation, txid, claims) => round.putScopedSettlementTxid({ roundId: RID, scope: `fed:${federation}`, txid, message: bytes, claims, payouts: 1 });

test('#1239 a round that takes any federation: the claims of every federation not REFUSED are its own, a refused one\'s are not', () => {
  const round = new Round(openStore(':memory:'));
  // the round's moves under "federations" (keepFederationMoves) carry every federation's claims; no round row exists
  round.putLockSettlementMoves({ roundId: RID, txid: 'federations', claims: ['41:1', '43:3', '44:4', '45:5'], payouts: 3 });
  fedRow(round, A, 'ta', 'ACCEPTED'); moves(round, A, 'ta', ['41:1', '43:3']);
  fedRow(round, B, 'tb', 'REFUSED'); moves(round, B, 'tb', ['44:4']);
  fedRow(round, C, 'tc2', 'SUBMITTING'); moves(round, C, 'tc1', ['45:9']); moves(round, C, 'tc2', ['45:5']);
  const own = ownClaimsOf(round, RID);
  console.log('  MEASURED #1239:', JSON.stringify([...own].sort()));
  assert.deepEqual([...own].sort(), ['41:1', '43:3', '45:5'], 'A\'s landed claims and C\'s current transaction are this round\'s own; B\'s refused lock is not, nor C\'s older build');
});

test('#1239 a round in one federation is read as before: its signed settlement\'s claims unless REFUSED', () => {
  const round = new Round(openStore(':memory:'));
  round.putLockSettlement({ roundId: RID, txid: 't1', message: bytes, signature: bytes, state: 'ACCEPTED', why: '' });
  round.putLockSettlementMoves({ roundId: RID, txid: 't1', claims: ['41:1'], payouts: 1 });
  assert.deepEqual([...ownClaimsOf(round, RID)], ['41:1']);
  round.putLockSettlement({ roundId: RID, txid: 't1', message: bytes, signature: bytes, state: 'REFUSED', why: 'no' });
  assert.deepEqual([...ownClaimsOf(round, RID)], []);
  round.putLockSettlementMoves({ roundId: RID, txid: 't0', claims: ['41:1'], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: 't1', message: bytes, signature: bytes, state: 'ACCEPTED', why: '' });
  assert.deepEqual([...ownClaimsOf(new Round(openStore(':memory:')), RID)], [], 'nothing kept, nothing own');
});
