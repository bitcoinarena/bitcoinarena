// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1249 (audit 2 #1204 SETTLEMENT-1): a round's row made ACCEPTED on another seat's landed transaction - read from the history by recordSubmit, the
// kept pass or recover - kept the moves of this seat's own txid, so what the round "moved" here was a transaction that never landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

const RID = new Uint8Array(32).fill(0x5e), b = new Uint8Array(4).fill(1);
const TA = 'aa'.repeat(32), TB = 'bb'.repeat(32);

test('#1249 a row written ACCEPTED on a txid of the history carries that txid\'s moves; ACCEPTED on the moves\' own txid leaves them', () => {
  const round = new Round(openStore(':memory:'));
  round.db.exec('PRAGMA foreign_keys = OFF');   // the round is this test's stub, not a row
  // this seat signed T_B and kept its moves; seat A's T_A is in the history too (taken, or read back)
  round.putSettlementTxid({ roundId: RID, txid: TB, message: b, claims: ['41:0', '42:0'], payouts: 3 });
  round.putSettlementTxid({ roundId: RID, txid: TA, message: b, claims: ['41:0', '43:0'], payouts: 2 });
  round.putLockSettlementMoves({ roundId: RID, txid: TB, claims: ['41:0', '42:0'], payouts: 3 });
  round.putLockSettlement({ roundId: RID, txid: TB, message: b, signature: b, state: 'SUBMITTING', why: '' });
  // T_A landed: the row is made ACCEPTED on it
  round.putLockSettlement({ roundId: RID, txid: TA, message: b, signature: b, state: 'ACCEPTED', why: 'in, from the history' });
  const m = round.lockSettlementMoves(RID);
  console.log('  MEASURED #1249:', JSON.stringify({ row: round.lockSettlement(RID).txid.slice(0, 4), moves: m.txid.slice(0, 4), claims: m.claims, payouts: m.payouts }));
  assert.equal(m.txid, TA, 'the moves stayed at the txid that never landed');
  assert.deepEqual(m.claims, ['41:0', '43:0']); assert.equal(m.payouts, 2);
  // a row ACCEPTED on its own moves' txid is left as kept
  const own = new Round(openStore(':memory:'));
  own.db.exec('PRAGMA foreign_keys = OFF');
  own.putLockSettlementMoves({ roundId: RID, txid: TB, claims: ['41:0'], payouts: 1 });
  own.putLockSettlement({ roundId: RID, txid: TB, message: b, signature: b, state: 'ACCEPTED', why: '' });
  assert.deepEqual(own.lockSettlementMoves(RID).claims, ['41:0']);
});
